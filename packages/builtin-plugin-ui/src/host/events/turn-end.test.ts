import { describe, expect, it, vi } from 'vitest'
import { handleTurnEnd, latestTodos, settledTodos, settleTodos } from './turn-end'

function sessionOf(events: readonly unknown[], append = vi.fn()): { snapshotEvents: () => readonly unknown[], append: typeof append } {
  return { snapshotEvents: () => events, append }
}

describe('todos 在回合结束时收敛', () => {
  it('把残留的 in_progress 降级为 pending 且不改原数组', () => {
    const todos = [
      { content: '读代码', status: 'completed' },
      { content: '写测试', status: 'in_progress' },
      { content: '收尾', status: 'pending' },
    ]

    expect(settledTodos(todos)).toEqual([
      { content: '读代码', status: 'completed' },
      { content: '写测试', status: 'pending' },
      { content: '收尾', status: 'pending' },
    ])
    expect(todos[1]?.status).toBe('in_progress')
  })

  it('没有 in_progress 时不做任何改写', () => {
    const todos = [
      { content: '读代码', status: 'completed' },
      { content: '收尾', status: 'pending' },
    ]

    expect(settledTodos(todos)).toBeUndefined()
    expect(settledTodos(undefined)).toBeUndefined()
    expect(settledTodos([])).toBeUndefined()
  })

  it('只取本回合最近一次 todo/write', () => {
    const events = [
      { type: 'turn/start' },
      { type: 'todo/write', data: { todos: [{ content: '旧的', status: 'in_progress' }] } },
      { type: 'turn/end' },
      { type: 'turn/start' },
      { type: 'todo/write', data: { todos: [{ content: '新的', status: 'in_progress' }] } },
      { type: 'turn/end' },
    ]

    expect(latestTodos(events)).toEqual([{ content: '新的', status: 'in_progress' }])
  })

  it('本回合没写过清单时视为空，不触碰上一回合的残留', () => {
    const events = [
      { type: 'turn/start' },
      { type: 'todo/write', data: { todos: [{ content: '旧的', status: 'in_progress' }] } },
      { type: 'turn/end' },
      { type: 'turn/start' },
      { type: 'turn/end' },
    ]

    expect(latestTodos(events)).toBeUndefined()
    expect(latestTodos(undefined)).toBeUndefined()
    expect(latestTodos([])).toBeUndefined()
  })

  it('settleTodos 回写一条收敛后的 todo/write', () => {
    const append = vi.fn()
    const session = sessionOf([
      { type: 'turn/start' },
      { type: 'todo/write', data: { todos: [{ content: '写测试', status: 'in_progress' }] } },
      { type: 'turn/end' },
    ], append)

    settleTodos(session)

    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith('todo/write', { todos: [{ content: '写测试', status: 'pending' }] })
  })

  it('没有可收敛的清单时不回写', () => {
    const append = vi.fn()
    const session = sessionOf([
      { type: 'turn/start' },
      { type: 'todo/write', data: { todos: [{ content: '写测试', status: 'completed' }] } },
      { type: 'turn/end' },
    ], append)

    settleTodos(session)

    expect(append).not.toHaveBeenCalled()
  })

  it('回合结束后延后一拍再回写，避开 append 重入保护', async () => {
    const append = vi.fn()
    const session = sessionOf([
      { type: 'turn/start' },
      { type: 'todo/write', data: { todos: [{ content: '写测试', status: 'in_progress' }] } },
      { type: 'turn/end' },
    ], append)

    handleTurnEnd(session, { type: 'turn/end' })
    expect(append).not.toHaveBeenCalled()

    await Promise.resolve()
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('其它事件不触发回写', async () => {
    const append = vi.fn()
    const session = sessionOf([
      { type: 'turn/start' },
      { type: 'todo/write', data: { todos: [{ content: '写测试', status: 'in_progress' }] } },
    ], append)

    handleTurnEnd(session, { type: 'todo/write' })
    await Promise.resolve()

    expect(append).not.toHaveBeenCalled()
  })
})
