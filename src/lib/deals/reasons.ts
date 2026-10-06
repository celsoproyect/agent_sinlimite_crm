// Lost reasons and stage kinds, kept apart from close.ts so client
// components can import them (close.ts pulls in the server-only
// automations engine).
export const LOST_REASONS = [
  'price',
  'no_response',
  'competitor',
  'not_interested',
  'timing',
  'other',
] as const
export type LostReason = (typeof LOST_REASONS)[number]

export function isLostReason(v: unknown): v is LostReason {
  return typeof v === 'string' && (LOST_REASONS as readonly string[]).includes(v)
}

const WON_NAME = /\b(won|ganad[oa]s?)\b/i
const LOST_NAME = /\b(lost|perdid[oa]s?)\b/i

/** A stage's kind. `kind` (migration 063) wins; before that column
 *  exists, a stage named "Won"/"Ganado" or "Lost"/"Perdido" counts. */
export function stageKind(stage: { name: string; kind?: string | null }): 'open' | 'won' | 'lost' {
  if (stage.kind === 'won' || stage.kind === 'lost' || stage.kind === 'open') return stage.kind
  if (WON_NAME.test(stage.name)) return 'won'
  if (LOST_NAME.test(stage.name)) return 'lost'
  return 'open'
}
