// ============================================================
// Keyword rules for Instagram comments (phase 2, migration 079). Pure:
// the matching is unit-tested, comments.ts does the work.
//
// Text is compared without accents, case, emojis or punctuation, and by
// whole words, so "preciosa" never fires "PRECIO" while "¡Precio!" and
// "precio por favor" do. A keyword of several words matches that phrase.
// Order: the post's own keyword rules, then the general ones, then the
// post's "any comment" rule, then a general "any comment" rule.
// A rule covers a list of posts (migration 080, `media_ids`); an empty
// list makes it general (every post).
// ============================================================

export type RuleMediaKind = 'image' | 'document'

/** Where a rule fires (migration 082): comments, story replies, DMs. */
export const RULE_TRIGGERS = ['comments', 'story_replies', 'dms'] as const
export type RuleTrigger = (typeof RULE_TRIGGERS)[number]

export function normalizeTriggers(raw: unknown): RuleTrigger[] {
  const list = Array.isArray(raw) ? raw.filter((t): t is RuleTrigger => (RULE_TRIGGERS as readonly string[]).includes(t as string)) : []
  return list.length ? [...new Set(list)] : ['comments']
}

export interface KeywordRule {
  id: string
  /** Legacy single post (079). Read `media_ids`. */
  media_id: string | null
  /** The posts/reels the rule answers on; [] = every post (general). */
  media_ids: string[]
  name: string
  keywords: string[]
  match_any: boolean
  public_replies: string[]
  dm_opening: string | null
  dm_button_label: string | null
  dm_text: string
  dm_link_url: string | null
  catalog_item_id: string | null
  /** A file of the rule's own (080): a PDF or a picture sent after the button. */
  dm_media_url: string | null
  dm_media_kind: RuleMediaKind | null
  dm_media_name: string | null
  /** Automation started once the content is delivered (080). */
  automation_id: string | null
  tag_id: string | null
  /** Where it fires (082); before 082 = comments only. */
  triggers: RuleTrigger[]
  /** Deliver the content only to followers of the account (082). */
  require_follow: boolean
  once_per_user: boolean
  active: boolean
  is_sample?: boolean
  created_at?: string
  updated_at?: string
}

/**
 * A rule row as the DB returns it, before or after migration 080: the
 * post list falls back to the single `media_id`, and the 080 fields
 * default to empty.
 */
export function normalizeRule(row: Record<string, unknown>): KeywordRule {
  const r = row as Partial<KeywordRule> & { id: string }
  const ids = Array.isArray(r.media_ids) ? r.media_ids.filter((m): m is string => typeof m === 'string' && !!m) : []
  return {
    ...(r as KeywordRule),
    media_id: r.media_id ?? null,
    media_ids: ids.length ? [...new Set(ids)] : r.media_id ? [r.media_id] : [],
    keywords: r.keywords ?? [],
    public_replies: r.public_replies ?? [],
    dm_text: r.dm_text ?? '',
    dm_media_url: r.dm_media_url ?? null,
    dm_media_kind: r.dm_media_kind === 'image' || r.dm_media_kind === 'document' ? r.dm_media_kind : null,
    dm_media_name: r.dm_media_name ?? null,
    automation_id: r.automation_id ?? null,
    triggers: normalizeTriggers(r.triggers),
    require_follow: r.require_follow === true,
    is_sample: r.is_sample ?? false,
  }
}

/** Whether a rule covers every post (no list of its own). */
export function isGeneralRule(rule: Pick<KeywordRule, 'media_ids'>): boolean {
  return rule.media_ids.length === 0
}

/** Lowercase, no accents, words separated by single spaces. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Whether `text` contains `keyword` as whole word(s). */
export function matchesKeyword(text: string, keyword: string): boolean {
  const kw = normalizeForMatch(keyword)
  if (!kw) return false
  return ` ${normalizeForMatch(text)} `.includes(` ${kw} `)
}

/** The rule a comment fires, or null. Inactive rules never fire. */
export function pickRule(
  rules: KeywordRule[],
  comment: { mediaId: string | null; text: string },
  trigger: RuleTrigger = 'comments',
): { rule: KeywordRule; keyword: string | null } | null {
  const active = rules.filter((r) => r.active && r.triggers.includes(trigger))
  const own = active.filter((r) => !!comment.mediaId && r.media_ids.includes(comment.mediaId))
  const general = active.filter(isGeneralRule)
  const byKeyword = (list: KeywordRule[]) => {
    for (const rule of list) {
      if (rule.match_any) continue
      const hit = rule.keywords.find((k) => matchesKeyword(comment.text, k))
      if (hit) return { rule, keyword: hit }
    }
    return null
  }
  const anyComment = (list: KeywordRule[]) => {
    const rule = list.find((r) => r.match_any)
    return rule ? { rule, keyword: null } : null
  }
  return byKeyword(own) ?? byKeyword(general) ?? anyComment(own) ?? anyComment(general)
}

/**
 * The rule a story reply or a DM fires (082). Only general rules (a story
 * or a DM is not on a post) whose triggers include it. DMs never fire
 * "any comment" rules, so normal chats still reach the AI; a story reply
 * can.
 */
export function pickMessageRule(
  rules: KeywordRule[],
  text: string,
  trigger: Exclude<RuleTrigger, 'comments'>,
): { rule: KeywordRule; keyword: string | null } | null {
  const pool = rules.filter((r) => r.active && isGeneralRule(r) && r.triggers.includes(trigger))
  for (const rule of pool) {
    if (rule.match_any) continue
    const hit = rule.keywords.find((k) => matchesKeyword(text, k))
    if (hit) return { rule, keyword: hit }
  }
  if (trigger === 'story_replies') {
    const any = pool.find((r) => r.match_any)
    if (any) return { rule: any, keyword: null }
  }
  return null
}

/** Cleans a keyword list: trimmed, no blanks, no duplicates (by normalized form). */
export function cleanKeywords(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of raw) {
    const trimmed = k.trim().slice(0, 60)
    const norm = normalizeForMatch(trimmed)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(trimmed)
  }
  return out.slice(0, 30)
}

/** Two rules answer on a common post (or are both general). */
function sameScope(a: Pick<KeywordRule, 'media_ids'>, b: Pick<KeywordRule, 'media_ids'>): boolean {
  if (isGeneralRule(a) || isGeneralRule(b)) return isGeneralRule(a) && isGeneralRule(b)
  return a.media_ids.some((m) => b.media_ids.includes(m))
}

/**
 * Keywords `rule` shares with another active rule of the same scope (a
 * post they both cover, or both general). Those would be ambiguous: the
 * first one would always win.
 */
export function keywordConflicts(
  rule: Pick<KeywordRule, 'id' | 'media_ids' | 'keywords' | 'match_any' | 'active'>,
  others: Pick<KeywordRule, 'id' | 'media_ids' | 'keywords' | 'match_any' | 'active' | 'name'>[],
): { keyword: string; ruleId: string; ruleName: string }[] {
  if (!rule.active) return []
  const out: { keyword: string; ruleId: string; ruleName: string }[] = []
  for (const other of others) {
    if (other.id === rule.id || !other.active || !sameScope(rule, other)) continue
    if (rule.match_any && other.match_any) {
      out.push({ keyword: '*', ruleId: other.id, ruleName: other.name })
      continue
    }
    const theirs = new Set(other.keywords.map(normalizeForMatch))
    for (const k of rule.keywords) {
      if (theirs.has(normalizeForMatch(k))) out.push({ keyword: k, ruleId: other.id, ruleName: other.name })
    }
  }
  return out
}

/** One of the public reply versions (they rotate so replies don't look copied). */
export function pickPublicReply(
  replies: string[],
  username: string | null,
  random: () => number = Math.random,
): string | null {
  const options = replies.map((r) => r.trim()).filter(Boolean)
  if (options.length === 0) return null
  const chosen = options[Math.floor(random() * options.length) % options.length]
  return chosen.replace(/\{\{\s*username\s*\}\}/gi, username ? `@${username}` : '').replace(/\s{2,}/g, ' ').trim()
}

/**
 * Instagram threads are one level deep: a reply to a reply lands in the
 * top-level comment's thread, where its author gets no notification and
 * can't tell it is for them. So a reply to a comment that is itself a
 * reply starts with @username (unless it already mentions them). Pure.
 */
export function threadReplyText(text: string, username: string | null, parentId: string | null): string {
  const clean = text.trim()
  if (!parentId || !username) return clean
  const handle = `@${username}`
  if (clean.toLowerCase().includes(handle.toLowerCase())) return clean
  return `${handle} ${clean}`
}

/** The content DM: the text plus the link on its own line. */
export function ruleContentText(rule: Pick<KeywordRule, 'dm_text' | 'dm_link_url'>): string {
  return [rule.dm_text.trim(), rule.dm_link_url?.trim() ?? ''].filter(Boolean).join('\n\n')
}

/** Quick-reply payload of a rule's button. */
export const RULE_BUTTON_PREFIX = 'IGRULE:'

export function ruleButtonPayload(ruleId: string): string {
  return `${RULE_BUTTON_PREFIX}${ruleId}`
}

/** A copy of a rule to open as a new one ("Duplicar"). */
export function duplicateRule(rule: KeywordRule, suffix: string): KeywordRule {
  return { ...rule, id: '', name: `${rule.name || ''} ${suffix}`.trim().slice(0, 80), is_sample: false }
}

export function ruleIdFromPayload(payload: string | null | undefined): string | null {
  if (!payload?.startsWith(RULE_BUTTON_PREFIX)) return null
  return payload.slice(RULE_BUTTON_PREFIX.length) || null
}
