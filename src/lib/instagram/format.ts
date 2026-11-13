// Instagram DMs show text as typed: no *bold*, _italic_ or ~strike~.
// The agent writes WhatsApp-style structure (FORMATTING_RULES), so the
// markers are dropped and the bullets and line breaks stay.

/** Meta's limit for one Instagram text message, in UTF-8 bytes. */
export const INSTAGRAM_TEXT_MAX_BYTES = 1000

export function toInstagramText(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1$2')
    .replace(/~([^~\n]+)~/g, '$1')
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim()
}

const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length

/**
 * Splits a long reply into messages that fit Instagram's limit, cutting
 * at paragraph breaks, then line breaks, then spaces, and only as a last
 * resort inside a word.
 */
export function splitInstagramText(text: string, maxBytes: number = INSTAGRAM_TEXT_MAX_BYTES): string[] {
  const clean = text.trim()
  if (!clean) return []
  if (bytes(clean) <= maxBytes) return [clean]

  const parts: string[] = []
  let rest = clean
  while (rest && bytes(rest) > maxBytes) {
    // Longest prefix that fits, by characters (code points).
    const chars = Array.from(rest)
    let fit = 0
    let size = 0
    for (const ch of chars) {
      const b = bytes(ch)
      if (size + b > maxBytes) break
      size += b
      fit++
    }
    const window = chars.slice(0, fit).join('')
    let cut = -1
    for (const sep of ['\n\n', '\n', ' ']) {
      const at = window.lastIndexOf(sep)
      if (at > window.length * 0.3) {
        cut = at
        break
      }
    }
    const head = (cut > 0 ? window.slice(0, cut) : window).trim()
    parts.push(head)
    rest = rest.slice(cut > 0 ? cut : window.length).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}
