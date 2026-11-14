import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// accounts.instagram_settings (migration 082): what the AI does with
// comments no keyword rule caught (phase 3), the story-mention thanks,
// ice breakers and persistent menu (phase 4) and the hourly DM limit
// (phase 5). Stored as jsonb; this file is the only reader, so a missing
// or partial object always comes back complete. Pure except the loader.
// ============================================================

export const COMMENT_CATEGORIES = ['question', 'interest', 'praise', 'complaint', 'spam', 'other'] as const
export type CommentCategory = (typeof COMMENT_CATEGORIES)[number]

/** What happens to a comment of one category. */
export interface CommentAction {
  /** A public reply under the comment. */
  public: boolean
  /** The one private DM Meta allows per comment. */
  dm: boolean
  /** In-app + Telegram alert to the owners/admins. */
  notify: boolean
  /** Hide the comment on Instagram (spam, insults). */
  hide: boolean
}

export interface IceBreaker {
  question: string
  /** Keyword rule whose content answers it; null = the AI answers. */
  rule_id: string | null
}

export type MenuItemKind = 'rule' | 'url' | 'ai'

export interface MenuItem {
  title: string
  kind: MenuItemKind
  rule_id: string | null
  url: string | null
}

export interface InstagramSettings {
  ai_comments: {
    enabled: boolean
    actions: Record<CommentCategory, CommentAction>
    /** Extra instructions from the owner ("never give prices in public"). */
    instructions: string
  }
  /** DM sent when someone mentions the account in their story; '' = none. */
  mention_thanks: string
  /** Sent when a rule asks the customer to follow first; '' = default. */
  follow_gate_text: string
  ice_breakers: IceBreaker[]
  menu: MenuItem[]
  /** Private replies per hour before the queue holds the rest (Meta: ~200). */
  dm_hourly_limit: number
  /** Last push of ice breakers/menu to Instagram. */
  profile_synced_at: string | null
  profile_error: string | null
}

export const MAX_ICE_BREAKERS = 4
export const MAX_MENU_ITEMS = 5
export const DEFAULT_DM_HOURLY_LIMIT = 180
/** Meta's own ceiling; the owner can only go lower. */
export const MAX_DM_HOURLY_LIMIT = 200

export const DEFAULT_FOLLOW_GATE_TEXT =
  'Para enviártelo, síguenos primero en Instagram 💛 y luego toca el botón otra vez 👇'

export const DEFAULT_COMMENT_ACTIONS: Record<CommentCategory, CommentAction> = {
  question: { public: true, dm: true, notify: false, hide: false },
  interest: { public: true, dm: true, notify: false, hide: false },
  praise: { public: true, dm: false, notify: false, hide: false },
  complaint: { public: false, dm: false, notify: true, hide: false },
  spam: { public: false, dm: false, notify: false, hide: true },
  other: { public: false, dm: false, notify: false, hide: false },
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function uuidOrNull(v: unknown): string | null {
  return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null
}

function httpsUrl(v: unknown): string | null {
  const s = str(v, 1000)
  return /^https?:\/\/\S+$/i.test(s) ? s : null
}

/** Any stored (or posted) value → a complete settings object. */
export function normalizeInstagramSettings(raw: unknown): InstagramSettings {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const ai = (o.ai_comments && typeof o.ai_comments === 'object' ? o.ai_comments : {}) as Record<string, unknown>
  const rawActions = (ai.actions && typeof ai.actions === 'object' ? ai.actions : {}) as Record<string, unknown>
  const actions = {} as Record<CommentCategory, CommentAction>
  for (const cat of COMMENT_CATEGORIES) {
    const d = DEFAULT_COMMENT_ACTIONS[cat]
    const a = (rawActions[cat] && typeof rawActions[cat] === 'object' ? rawActions[cat] : {}) as Record<string, unknown>
    actions[cat] = {
      public: bool(a.public, d.public),
      dm: bool(a.dm, d.dm),
      notify: bool(a.notify, d.notify),
      hide: bool(a.hide, d.hide),
    }
  }

  const iceBreakers: IceBreaker[] = []
  for (const item of Array.isArray(o.ice_breakers) ? o.ice_breakers : []) {
    const i = (item ?? {}) as Record<string, unknown>
    const question = str(i.question, 80)
    if (!question) continue
    iceBreakers.push({ question, rule_id: uuidOrNull(i.rule_id) })
    if (iceBreakers.length >= MAX_ICE_BREAKERS) break
  }

  const menu: MenuItem[] = []
  for (const item of Array.isArray(o.menu) ? o.menu : []) {
    const m = (item ?? {}) as Record<string, unknown>
    const title = str(m.title, 30)
    if (!title) continue
    const kind: MenuItemKind = m.kind === 'rule' || m.kind === 'url' ? m.kind : 'ai'
    const rule_id = kind === 'rule' ? uuidOrNull(m.rule_id) : null
    const url = kind === 'url' ? httpsUrl(m.url) : null
    if (kind === 'rule' && !rule_id) continue
    if (kind === 'url' && !url) continue
    menu.push({ title, kind, rule_id, url })
    if (menu.length >= MAX_MENU_ITEMS) break
  }

  const limit = typeof o.dm_hourly_limit === 'number' && Number.isFinite(o.dm_hourly_limit) ? Math.round(o.dm_hourly_limit) : DEFAULT_DM_HOURLY_LIMIT

  return {
    ai_comments: {
      enabled: bool(ai.enabled, false),
      actions,
      instructions: str(ai.instructions, 1500),
    },
    mention_thanks: str(o.mention_thanks, 900),
    follow_gate_text: str(o.follow_gate_text, 600),
    ice_breakers: iceBreakers,
    menu,
    dm_hourly_limit: Math.min(MAX_DM_HOURLY_LIMIT, Math.max(1, limit)),
    profile_synced_at: typeof o.profile_synced_at === 'string' ? o.profile_synced_at : null,
    profile_error: typeof o.profile_error === 'string' ? o.profile_error.slice(0, 500) : null,
  }
}

/** Whether the ice breakers or the menu differ (they must be pushed to Instagram). */
export function profileChanged(a: InstagramSettings, b: InstagramSettings): boolean {
  return JSON.stringify([a.ice_breakers, a.menu]) !== JSON.stringify([b.ice_breakers, b.menu])
}

/**
 * The account's settings, complete. Before migration 082 (42703) or on
 * any read error it returns the defaults, which keep every new feature
 * off.
 */
export async function loadInstagramSettings(db: SupabaseClient, accountId: string): Promise<InstagramSettings> {
  const { data, error } = await db.from('accounts').select('instagram_settings').eq('id', accountId).maybeSingle()
  if (error) {
    if (error.code !== '42703') console.error('[instagram] loading the settings failed:', error)
    return normalizeInstagramSettings(null)
  }
  return normalizeInstagramSettings(data?.instagram_settings)
}
