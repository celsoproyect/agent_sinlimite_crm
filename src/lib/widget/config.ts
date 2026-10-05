// ============================================================
// Web widget appearance (accounts.widget_config, migration 060).
//
// Shared by the public config endpoint the widget fetches on load and
// by the Settings editor that writes it, so both agree on the shape and
// the limits. The stored JSON is whatever an admin saved — always run it
// through normalizeWidgetConfig before using it.
// ============================================================

export interface WidgetQuickQuestion {
  /** One emoji shown in the little tile next to the question. */
  icon: string
  text: string
}

export interface WidgetConfig {
  agentName: string
  /** Shown under the name in the header, before "· En línea". */
  subtitle: string
  avatarUrl: string | null
  /** Optional banner image under the header (a character, a product…). */
  heroImageUrl: string | null
  /** Empty → "¡Hola! Soy {agentName} 👋". */
  welcomeTitle: string
  welcomeText: string
  quickQuestions: WidgetQuickQuestion[]
  /** Empty → "{agentName} es un asistente virtual. …". */
  disclaimer: string
  /** Header / button color, `#rrggbb`. */
  primaryColor: string
}

export const WIDGET_LIMITS = {
  agentName: 40,
  subtitle: 80,
  welcomeTitle: 80,
  welcomeText: 300,
  disclaimer: 160,
  questionText: 120,
  questionIcon: 8,
  quickQuestions: 6,
  url: 1000,
} as const

export const DEFAULT_WIDGET_ICON = '💬'

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  agentName: 'Asistente',
  subtitle: 'Asistente virtual',
  avatarUrl: null,
  heroImageUrl: null,
  welcomeTitle: '',
  welcomeText: 'Estoy aquí para ayudarte. ¿En qué te puedo ayudar hoy?',
  quickQuestions: [],
  disclaimer: '',
  primaryColor: '#0b2d5b',
}

const COLOR_RE = /^#[0-9a-f]{6}$/i
const URL_RE = /^https?:\/\/\S+$/i

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

function url(v: unknown): string | null {
  const s = str(v, WIDGET_LIMITS.url)
  return URL_RE.test(s) ? s : null
}

/**
 * Coerce whatever is stored (or posted from the editor) into a complete,
 * safe WidgetConfig: unknown keys dropped, strings trimmed and capped,
 * URLs limited to http(s), color validated, empty questions removed.
 */
export function normalizeWidgetConfig(raw: unknown): WidgetConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_WIDGET_CONFIG

  const questions: WidgetQuickQuestion[] = []
  if (Array.isArray(r.quickQuestions)) {
    for (const q of r.quickQuestions) {
      if (!q || typeof q !== 'object') continue
      const item = q as Record<string, unknown>
      const text = str(item.text, WIDGET_LIMITS.questionText)
      if (!text) continue
      questions.push({
        icon: str(item.icon, WIDGET_LIMITS.questionIcon) || DEFAULT_WIDGET_ICON,
        text,
      })
      if (questions.length >= WIDGET_LIMITS.quickQuestions) break
    }
  }

  const color = str(r.primaryColor, 7)

  return {
    agentName: str(r.agentName, WIDGET_LIMITS.agentName) || d.agentName,
    subtitle: str(r.subtitle, WIDGET_LIMITS.subtitle) || d.subtitle,
    avatarUrl: url(r.avatarUrl),
    heroImageUrl: url(r.heroImageUrl),
    welcomeTitle: str(r.welcomeTitle, WIDGET_LIMITS.welcomeTitle),
    welcomeText: str(r.welcomeText, WIDGET_LIMITS.welcomeText) || d.welcomeText,
    quickQuestions: questions,
    disclaimer: str(r.disclaimer, WIDGET_LIMITS.disclaimer),
    primaryColor: COLOR_RE.test(color) ? color.toLowerCase() : d.primaryColor,
  }
}
