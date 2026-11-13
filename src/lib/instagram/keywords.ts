// ============================================================
// Keyword rules for Instagram comments (phase 2, migration 079). Pure:
// the matching is unit-tested, comments.ts does the work.
//
// Text is compared without accents, case, emojis or punctuation, and by
// whole words, so "preciosa" never fires "PRECIO" while "¡Precio!" and
// "precio por favor" do. A keyword of several words matches that phrase.
// Order: the post's own keyword rules, then the general ones, then the
// post's "any comment" rule, then a general "any comment" rule.
// ============================================================

export interface KeywordRule {
  id: string
  media_id: string | null
  name: string
  keywords: string[]
  match_any: boolean
  public_replies: string[]
  dm_opening: string | null
  dm_button_label: string | null
  dm_text: string
  dm_link_url: string | null
  catalog_item_id: string | null
  tag_id: string | null
  once_per_user: boolean
  active: boolean
  created_at?: string
  updated_at?: string
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
): { rule: KeywordRule; keyword: string | null } | null {
  const active = rules.filter((r) => r.active)
  const own = active.filter((r) => r.media_id && r.media_id === comment.mediaId)
  const general = active.filter((r) => !r.media_id)
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

/**
 * Keywords `rule` shares with another active rule of the same scope (the
 * same post, or both general). Those would be ambiguous: the first one
 * would always win.
 */
export function keywordConflicts(
  rule: Pick<KeywordRule, 'id' | 'media_id' | 'keywords' | 'match_any' | 'active'>,
  others: Pick<KeywordRule, 'id' | 'media_id' | 'keywords' | 'match_any' | 'active' | 'name'>[],
): { keyword: string; ruleId: string; ruleName: string }[] {
  if (!rule.active) return []
  const out: { keyword: string; ruleId: string; ruleName: string }[] = []
  for (const other of others) {
    if (other.id === rule.id || !other.active || (other.media_id ?? null) !== (rule.media_id ?? null)) continue
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

/** The content DM: the text plus the link on its own line. */
export function ruleContentText(rule: Pick<KeywordRule, 'dm_text' | 'dm_link_url'>): string {
  return [rule.dm_text.trim(), rule.dm_link_url?.trim() ?? ''].filter(Boolean).join('\n\n')
}

/** Quick-reply payload of a rule's button. */
export const RULE_BUTTON_PREFIX = 'IGRULE:'

export function ruleButtonPayload(ruleId: string): string {
  return `${RULE_BUTTON_PREFIX}${ruleId}`
}

export function ruleIdFromPayload(payload: string | null | undefined): string | null {
  if (!payload?.startsWith(RULE_BUTTON_PREFIX)) return null
  return payload.slice(RULE_BUTTON_PREFIX.length) || null
}
