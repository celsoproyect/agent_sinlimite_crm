import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  /**
   * Message key under `Automations.builder.triggers` for the pill label,
   * translated at the render site. Null for trigger types this build
   * doesn't know, which render `rawLabel` instead.
   */
  labelKey: string | null
  /** The raw trigger type, shown when `labelKey` is null. */
  rawLabel: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

const PILL_CLASS: Record<AutomationTriggerType, string> = {
  new_message_received: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  first_inbound_message: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  keyword_match: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  new_contact_created: 'border-primary/30 bg-primary/10 text-primary',
  conversation_assigned: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  tag_added: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  time_based: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  interactive_reply: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  deal_won: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  deal_lost: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> =
  Object.fromEntries(
    (Object.keys(PILL_CLASS) as AutomationTriggerType[]).map((type) => [
      type,
      { labelKey: `${type}.label`, rawLabel: type, pillClass: PILL_CLASS[type] },
    ]),
  ) as Record<AutomationTriggerType, TriggerMeta>

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      labelKey: null,
      rawLabel: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  )
}

/** Translator for the `Automations.relative` namespace. */
export type RelativeTranslator = (
  key: 'never' | 'justNow' | 'minutesAgo' | 'hoursAgo' | 'daysAgo',
  values?: { count: number },
) => string

export function formatRelative(
  iso: string | null | undefined,
  t: RelativeTranslator,
  locale?: string,
): string {
  if (!iso) return t('never')
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return t('never')
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('justNow')
  if (diffSec < 3600) return t('minutesAgo', { count: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('hoursAgo', { count: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('daysAgo', { count: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString(locale)
}
