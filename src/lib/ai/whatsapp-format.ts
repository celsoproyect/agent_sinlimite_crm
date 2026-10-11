// ============================================================
// WhatsApp formatting helpers. WhatsApp bolds with *single* asterisks
// and has no headings, so the markdown models slip into (`**x**`,
// `# Title`) arrives as literal symbols. `toWhatsAppFormatting` fixes
// those before any channel sends the reply.
// ============================================================

/** Convert stray markdown into WhatsApp formatting. Pure. */
export function toWhatsAppFormatting(text: string): string {
  if (!text) return text
  return (
    text
      // **bold** / __bold__ -> *bold*
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '*$1*')
      .replace(/__(?=\S)([^_\n]*?\S)__/g, '*$1*')
      // # Heading -> *Heading*
      .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, title: string) => `*${title.replace(/\*/g, '')}*`)
      // [label](url) -> label: url
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2')
      // "- item" / "* item" bullets -> "• item"
      .replace(/^([ \t]*)[-*][ \t]+(?=\S)/gm, '$1• ')
      // at most one blank line in a row
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

const CURRENCY_PREFIX: Record<string, string> = {
  DOP: 'RD$',
  USD: 'US$',
  EUR: '€',
}

/** "RD$15,000" / "US$49.90" / "MXN 300". */
export function formatPrice(price: number | string | null | undefined, currency?: string | null): string {
  if (price == null || price === '') return ''
  const n = typeof price === 'number' ? price : Number(String(price).replace(/,/g, ''))
  if (!Number.isFinite(n)) return `${currency ?? ''} ${price}`.trim()
  const amount = n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })
  const code = (currency ?? '').trim().toUpperCase()
  if (!code) return amount
  const prefix = CURRENCY_PREFIX[code]
  return prefix ? `${prefix}${amount}` : `${code} ${amount}`
}

/** Caption for a catalog card: bold name, then the price. */
export function productCardCaption(name: string, price: number | string | null | undefined, currency?: string | null): string {
  const priceText = formatPrice(price, currency)
  return [`*${name.replace(/\*/g, '')}*`, priceText ? `💰 ${priceText}` : ''].filter(Boolean).join('\n')
}

export type WhatsAppSegment = { text: string; bold: boolean; italic: boolean; strike: boolean }

/** Split WhatsApp-formatted text into styled runs for rendering (inbox
 *  bubbles). Markers must hug non-space text, like WhatsApp itself. */
export function parseWhatsAppFormatting(text: string): WhatsAppSegment[] {
  const out: WhatsAppSegment[] = []
  const re = /(^|[\s(¡¿"'])([*_~])(?=\S)([^\n]*?\S)\2(?=$|[\s).,:;!?"'])/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length
    if (start > last) out.push({ text: text.slice(last, start), bold: false, italic: false, strike: false })
    out.push({ text: m[3], bold: m[2] === '*', italic: m[2] === '_', strike: m[2] === '~' })
    last = start + m[3].length + 2
    re.lastIndex = last
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, italic: false, strike: false })
  return out
}
