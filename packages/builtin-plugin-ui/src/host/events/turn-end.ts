import type { PlanSession } from '../service/session.types'
import { eventOf } from '../../shared/content-risk'

const IN_PROGRESS = 'in_progress'
const PENDING = 'pending'

interface TodoItem {
  content: string
  status: string
}

export function latestTodos(events: readonly unknown[] | undefined): TodoItem[] | undefined {
  if (events === undefined)
    return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = eventOf(events[index])
    if (event?.type === 'turn/start')
      return undefined
    if (event?.type !== 'todo/write')
      continue
    const todos = (event.data as { todos?: unknown } | undefined)?.todos
    return Array.isArray(todos) ? todos as TodoItem[] : undefined
  }
  return undefined
}

export function settledTodos(todos: readonly TodoItem[] | undefined): TodoItem[] | undefined {
  if (todos === undefined || !todos.some(todo => todo.status === IN_PROGRESS))
    return undefined
  return todos.map(todo => todo.status === IN_PROGRESS ? { ...todo, status: PENDING } : todo)
}

export function settleTodos(session: PlanSession): void {
  const events = session.snapshotEvents?.()
  if (events === undefined || typeof session.append !== 'function')
    return
  const settled = settledTodos(latestTodos(events))
  if (settled !== undefined)
    session.append('todo/write', { todos: settled })
}

export function handleTurnEnd(session: PlanSession, event: unknown): void {
  if (eventOf(event)?.type !== 'turn/end')
    return
  queueMicrotask(() => settleTodos(session))
}
