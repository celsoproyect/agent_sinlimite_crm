// ============================================================
// Automatic chat assignment (module `auto_assign`, migration 076).
// Shared by the server and the browser: the settings shape, its
// normalizer and the pure "who's next" pick.
// ============================================================

export const ASSIGNMENT_MODES = ['off', 'round_robin', 'sequence', 'least_busy'] as const
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number]

/** Why a chat was assigned (`conversations.assignment_reason`). */
export type AssignmentReason = 'requested' | 'missing_info' | 'new_chat'

export interface AssignmentSettings {
  mode: AssignmentMode
  /** Teammates in the rotation, in order (the sequence order). Empty =
   *  every owner, admin and agent. */
  members: string[]
  /** Minutes the assignee has to answer before the chat moves on.
   *  null = never move it. */
  reassign_minutes: number | null
  /** Also assign new chats while the AI isn't answering (switched off,
   *  out of monthly replies, or paused on that chat). */
  assign_when_ai_off: boolean
}

export const DEFAULT_REASSIGN_MINUTES = 10
export const MIN_REASSIGN_MINUTES = 1
export const MAX_REASSIGN_MINUTES = 24 * 60
const MAX_MEMBERS = 100

export const DEFAULT_ASSIGNMENT_SETTINGS: AssignmentSettings = {
  mode: 'off',
  members: [],
  reassign_minutes: DEFAULT_REASSIGN_MINUTES,
  assign_when_ai_off: false,
}

function isMode(v: unknown): v is AssignmentMode {
  return typeof v === 'string' && (ASSIGNMENT_MODES as readonly string[]).includes(v)
}

/** Read `accounts.assignment_settings` (or a request body) into a full,
 *  valid settings object. Anything malformed falls back to the default. */
export function normalizeAssignmentSettings(raw: unknown): AssignmentSettings {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const members = Array.isArray(src.members)
    ? [...new Set(src.members.filter((m): m is string => typeof m === 'string' && m.length > 0))].slice(0, MAX_MEMBERS)
    : []
  let reassign: number | null = DEFAULT_REASSIGN_MINUTES
  if (src.reassign_minutes === null) reassign = null
  else if (typeof src.reassign_minutes === 'number' && Number.isFinite(src.reassign_minutes)) {
    reassign = Math.min(MAX_REASSIGN_MINUTES, Math.max(MIN_REASSIGN_MINUTES, Math.round(src.reassign_minutes)))
  }
  return {
    mode: isMode(src.mode) ? src.mode : 'off',
    members,
    reassign_minutes: reassign,
    assign_when_ai_off: src.assign_when_ai_off === true,
  }
}

export interface AssignCandidate {
  user_id: string
  /** Last automatic assignment (round-robin turn); null = never. */
  last_assigned_at: string | null
  /** Chats assigned to them that aren't closed. */
  open_chats: number
}

/**
 * Who gets the chat. `candidates` are the available teammates already in
 * rotation order. `current` is the person it's moving away from (the
 * reassign timer): they're skipped, and a sequence continues after them.
 */
export function pickAssignee(
  mode: AssignmentMode,
  candidates: AssignCandidate[],
  current: string | null = null,
): string | null {
  if (mode === 'off') return null
  const pool = candidates.filter((c) => c.user_id !== current)
  if (pool.length === 0) return null

  if (mode === 'sequence') {
    if (!current) return pool[0].user_id
    const at = candidates.findIndex((c) => c.user_id === current)
    if (at < 0) return pool[0].user_id
    for (let step = 1; step <= candidates.length; step++) {
      const next = candidates[(at + step) % candidates.length]
      if (next.user_id !== current) return next.user_id
    }
    return null
  }

  const turn = (c: AssignCandidate) => (c.last_assigned_at ? Date.parse(c.last_assigned_at) : -Infinity)
  const order = new Map(candidates.map((c, i) => [c.user_id, i]))
  const sorted = [...pool].sort((a, b) => {
    if (mode === 'least_busy' && a.open_chats !== b.open_chats) return a.open_chats - b.open_chats
    const byTurn = turn(a) - turn(b)
    if (byTurn !== 0 && !Number.isNaN(byTurn)) return byTurn
    return (order.get(a.user_id) ?? 0) - (order.get(b.user_id) ?? 0)
  })
  return sorted[0].user_id
}

/** Put the available teammates in rotation order: the owner's list when
 *  set (unknown ids dropped), else the team as it comes. */
export function rotationOrder<T extends { user_id: string }>(team: T[], members: string[]): T[] {
  if (members.length === 0) return team
  const byId = new Map(team.map((m) => [m.user_id, m]))
  return members.map((id) => byId.get(id)).filter((m): m is T => !!m)
}
