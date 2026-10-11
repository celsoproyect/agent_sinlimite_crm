// ============================================================
// Lead prequalification (module `ai_qualification`, migration 075).
// The agent gathers a few facts about every customer in passing (what
// they want, why, when, budget, plus the owner's own questions) and
// reports them with `save_qualification`. They live in
// `contacts.qualification`, show in the inbox sidebar and travel with
// the handoff alert, so the person who takes over starts informed.
// ============================================================

export type LeadTemperature = 'hot' | 'warm' | 'cold'

export const LEAD_TEMPERATURES: LeadTemperature[] = ['hot', 'warm', 'cold']

export interface QualificationAnswer {
  question: string
  answer: string
}

export interface Qualification {
  /** Product or service they're interested in. */
  interest?: string
  /** The need or goal behind it. */
  need?: string
  /** When they want it. */
  timeline?: string
  /** Budget, as they said it. */
  budget?: string
  /** Answers to the owner's own questions. */
  answers?: QualificationAnswer[]
  temperature?: LeadTemperature
  /** One or two lines for the team. */
  summary?: string
  /** The customer confirmed (or gave) the name on file. */
  name_confirmed?: boolean
  updated_at?: string
}

/** Fallback questions when the owner hasn't written their own. */
export const DEFAULT_QUALIFICATION_QUESTIONS = [
  'Si es para uso personal o para su negocio (si es un negocio: el nombre de la empresa y a qué se dedica)',
  'Qué producto o servicio le interesa',
  'Para qué lo necesita o qué quiere resolver',
  'Qué usa hoy o cómo lo resuelve ahora (solo si aplica)',
  'Para cuándo lo necesita',
  'Si decide solo o con alguien más',
  'Si tiene un presupuesto aproximado (solo si encaja natural en la conversación)',
  'Cómo supo de nosotros',
]

const MAX_TEXT = 300
const MAX_SUMMARY = 600
const MAX_ANSWERS = 10

function clean(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : undefined
}

/** Validate the model's `save_qualification` arguments. Every field is
 *  optional, but at least one must carry something. */
export function parseQualification(rawArgs: unknown): { qualification: Qualification } | { error: string } {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const q: Qualification = {}
  const interest = clean(args.interest)
  const need = clean(args.need)
  const timeline = clean(args.timeline)
  const budget = clean(args.budget)
  const summary = clean(args.summary, MAX_SUMMARY)
  if (interest) q.interest = interest
  if (need) q.need = need
  if (timeline) q.timeline = timeline
  if (budget) q.budget = budget
  if (summary) q.summary = summary
  if (typeof args.temperature === 'string' && LEAD_TEMPERATURES.includes(args.temperature as LeadTemperature)) {
    q.temperature = args.temperature as LeadTemperature
  }
  if (Array.isArray(args.answers)) {
    const answers: QualificationAnswer[] = []
    for (const item of args.answers) {
      if (typeof item !== 'object' || item === null) continue
      const question = clean((item as Record<string, unknown>).question)
      const answer = clean((item as Record<string, unknown>).answer)
      if (question && answer) answers.push({ question, answer })
      if (answers.length >= MAX_ANSWERS) break
    }
    if (answers.length > 0) q.answers = answers
  }
  if (Object.keys(q).length === 0) {
    return { error: 'Pass at least one of interest, need, timeline, budget, answers, temperature or summary.' }
  }
  return { qualification: q }
}

/** Merge what the model reported this turn over what's stored: new
 *  values win, missing ones keep the old, answers merge by question. */
export function mergeQualification(
  previous: Qualification | null | undefined,
  next: Qualification,
  now: Date = new Date(),
): Qualification {
  const base: Qualification = { ...(previous ?? {}) }
  const answers = [...(base.answers ?? [])]
  for (const a of next.answers ?? []) {
    const i = answers.findIndex((x) => x.question.toLowerCase() === a.question.toLowerCase())
    if (i >= 0) answers[i] = a
    else answers.push(a)
  }
  const merged: Qualification = { ...base, ...stripUndefined(next), updated_at: now.toISOString() }
  if (answers.length > 0) merged.answers = answers.slice(0, MAX_ANSWERS)
  return merged
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** True when this update turns the lead hot for the first time. */
export function becameHot(previous: Qualification | null | undefined, merged: Qualification): boolean {
  return merged.temperature === 'hot' && previous?.temperature !== 'hot'
}

const TEMPERATURE_LABEL: Record<LeadTemperature, string> = {
  hot: '🔥 Caliente',
  warm: '🌤️ Tibio',
  cold: '❄️ Frío',
}

export function temperatureLabel(t: LeadTemperature | undefined): string | null {
  return t ? TEMPERATURE_LABEL[t] : null
}

/** Plain-text block for Telegram, notes and the handoff summary. */
export function formatQualificationBlock(q: Qualification | null | undefined, name?: string | null): string {
  if (!q) return ''
  const lines: string[] = []
  if (name) lines.push(`👤 Nombre: ${name}`)
  if (q.interest) lines.push(`🎯 Interés: ${q.interest}`)
  if (q.need) lines.push(`💬 Necesidad: ${q.need}`)
  if (q.timeline) lines.push(`📅 Cuándo: ${q.timeline}`)
  if (q.budget) lines.push(`💰 Presupuesto: ${q.budget}`)
  for (const a of q.answers ?? []) lines.push(`• ${a.question}: ${a.answer}`)
  const temp = temperatureLabel(q.temperature)
  if (temp) lines.push(`🌡️ Temperatura: ${temp}`)
  if (q.summary) lines.push(`📝 ${q.summary}`)
  if (lines.length === 0 || (lines.length === 1 && name)) return ''
  return `📋 Precalificación\n${lines.join('\n')}`
}

/** Short prompt digest of what the agent already knows, so it never
 *  asks the same thing twice. */
export function formatKnownQualification(q: Qualification | null | undefined): string | null {
  if (!q) return null
  const parts: string[] = []
  if (q.interest) parts.push(`interest: ${q.interest}`)
  if (q.need) parts.push(`need: ${q.need}`)
  if (q.timeline) parts.push(`timeline: ${q.timeline}`)
  if (q.budget) parts.push(`budget: ${q.budget}`)
  for (const a of q.answers ?? []) parts.push(`${a.question}: ${a.answer}`)
  if (q.temperature) parts.push(`temperature: ${q.temperature}`)
  return parts.length > 0 ? parts.join('; ') : null
}

/** The owner's questions, one per line; blank = the defaults. */
export function qualificationQuestionList(custom: string | null | undefined): string[] {
  const own = (custom ?? '')
    .split('\n')
    .map((l) => l.replace(/^[\s\-•*\d.)]+/, '').trim())
    .filter(Boolean)
  return own.length > 0 ? own.slice(0, MAX_ANSWERS) : DEFAULT_QUALIFICATION_QUESTIONS
}
