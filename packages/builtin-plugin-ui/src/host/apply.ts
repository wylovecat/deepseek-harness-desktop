import type { HostContext } from './types'
import { PLUGIN_ID } from '../shared/constants'
import { handlePreStep } from './events/pre-step'
import { handleTurnEnd } from './events/turn-end'
import { server } from './server'

const ROUTES_EFFECT = `${PLUGIN_ID}: routes`

export function apply(ctx: HostContext): void {
  ctx.on('agent/pre-step', handlePreStep)
  ctx.on('session/event', handleTurnEnd)

  ctx.effect(() => server(ctx), ROUTES_EFFECT)
}
