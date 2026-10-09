'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Radix Select can't use an empty-string item value, so the "leave
// unassigned" choice gets a sentinel that maps to null in the payload.
const HANDOFF_QUEUE = '__queue__';
const NO_LEAD_PIPELINE = '__none__';

/**
 * The account-owned half of the AI agent (migration 072). Edited by the
 * account's owner/admin in Configuración → Agente de IA and by the super
 * admin per account in Super admin → Cuentas; both save the same fields.
 */
export interface AgentBehaviour {
  systemPrompt: string;
  isActive: boolean;
  autoReplyEnabled: boolean;
  maxPerConversation: number;
  unlimitedReplies: boolean;
  replyDelaySeconds: number;
  temperature: number;
  /** '' = shared queue. */
  handoffAgentId: string;
  handoffOnMissingInfo: boolean;
  /** '' = no lead capture. */
  leadPipelineId: string;
}

export const DEFAULT_AGENT_BEHAVIOUR: AgentBehaviour = {
  systemPrompt: '',
  isActive: false,
  autoReplyEnabled: false,
  maxPerConversation: 3,
  unlimitedReplies: false,
  replyDelaySeconds: 0,
  temperature: 0.7,
  handoffAgentId: '',
  handoffOnMissingInfo: true,
  leadPipelineId: '',
};

/** Map an `ai_configs` row (snake_case, from the APIs) onto the form. */
export function behaviourFromRow(row: Record<string, unknown> | null | undefined): AgentBehaviour {
  if (!row) return { ...DEFAULT_AGENT_BEHAVIOUR };
  const max = row.auto_reply_max_per_conversation as number | null | undefined;
  return {
    systemPrompt: (row.system_prompt as string | null) ?? '',
    isActive: row.is_active === true,
    autoReplyEnabled: row.auto_reply_enabled === true,
    maxPerConversation: max ?? 3,
    unlimitedReplies: max === null,
    replyDelaySeconds: (row.reply_delay_seconds as number | undefined) ?? 0,
    temperature: (row.temperature as number | undefined) ?? 0.7,
    handoffAgentId: (row.handoff_agent_id as string | null) ?? '',
    handoffOnMissingInfo: row.handoff_on_missing_info !== false,
    leadPipelineId: (row.lead_pipeline_id as string | null) ?? '',
  };
}

/** The body the save endpoints expect. */
export function behaviourToBody(b: AgentBehaviour) {
  return {
    system_prompt: b.systemPrompt.trim() || null,
    is_active: b.isActive,
    auto_reply_enabled: b.autoReplyEnabled,
    auto_reply_max_per_conversation: b.unlimitedReplies ? null : b.maxPerConversation,
    reply_delay_seconds: b.replyDelaySeconds,
    temperature: b.temperature,
    handoff_agent_id: b.handoffAgentId || null,
    handoff_on_missing_info: b.handoffOnMissingInfo,
    lead_pipeline_id: b.leadPipelineId || null,
  };
}

export interface Option {
  id: string;
  label: string;
}

export function AgentBehaviourForm({
  value,
  onChange,
  members,
  pipelines,
  disabled,
  idPrefix = 'ai',
}: {
  value: AgentBehaviour;
  onChange: (next: AgentBehaviour) => void;
  members: Option[];
  pipelines: Option[];
  disabled: boolean;
  idPrefix?: string;
}) {
  const t = useTranslations('Settings.aiConfig');
  const set = <K extends keyof AgentBehaviour>(key: K, v: AgentBehaviour[K]) =>
    onChange({ ...value, [key]: v });
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={id('prompt')}>{t('businessContext')}</Label>
        <Textarea
          id={id('prompt')}
          value={value.systemPrompt}
          onChange={(e) => set('systemPrompt', e.target.value)}
          placeholder={t('promptPlaceholder')}
          rows={6}
          disabled={disabled}
        />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t('enableAssistant')}</p>
          <p className="text-xs text-muted-foreground">{t('enableAssistantDesc')}</p>
        </div>
        <Switch
          checked={value.isActive}
          onCheckedChange={(v) => set('isActive', v)}
          disabled={disabled}
        />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t('autoReply')}</p>
          <p className="text-xs text-muted-foreground">{t('autoReplyDesc')}</p>
        </div>
        <Switch
          checked={value.autoReplyEnabled}
          onCheckedChange={(v) => set('autoReplyEnabled', v)}
          disabled={disabled || !value.isActive}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <Label htmlFor={id('max')}>{t('maxAutoReplies')}</Label>
          <p className="text-xs text-muted-foreground">{t('maxAutoRepliesDesc')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Input
            id={id('max')}
            type="number"
            min={1}
            max={20}
            value={value.maxPerConversation}
            onChange={(e) =>
              set('maxPerConversation', Math.min(20, Math.max(1, Number(e.target.value) || 1)))
            }
            disabled={disabled || !value.autoReplyEnabled || value.unlimitedReplies}
            className="w-20"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={value.unlimitedReplies}
              onCheckedChange={(v) => set('unlimitedReplies', v)}
              disabled={disabled || !value.autoReplyEnabled}
            />
            {t('unlimitedReplies')}
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={id('reply-delay')}>{t('replyDelay')}</Label>
          <p className="text-xs text-muted-foreground">{t('replyDelayDesc')}</p>
        </div>
        <Input
          id={id('reply-delay')}
          type="number"
          min={0}
          max={300}
          value={value.replyDelaySeconds}
          onChange={(e) =>
            set(
              'replyDelaySeconds',
              Math.min(300, Math.max(0, Math.floor(Number(e.target.value) || 0))),
            )
          }
          disabled={disabled || !value.autoReplyEnabled}
          className="w-20"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={id('temperature')}>{t('temperature')}</Label>
          <p className="text-xs text-muted-foreground">{t('temperatureDesc')}</p>
        </div>
        <Input
          id={id('temperature')}
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={value.temperature}
          onChange={(e) =>
            set('temperature', Math.min(2, Math.max(0, Number(e.target.value) || 0)))
          }
          disabled={disabled}
          className="w-20"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={id('handoff')}>{t('handoffTo')}</Label>
        <p className="text-xs text-muted-foreground">{t('handoffToDesc')}</p>
        <Select
          value={value.handoffAgentId || HANDOFF_QUEUE}
          onValueChange={(v) => set('handoffAgentId', !v || v === HANDOFF_QUEUE ? '' : v)}
          disabled={disabled || !value.autoReplyEnabled}
        >
          <SelectTrigger id={id('handoff')}>
            <SelectValue>
              {(v: string) =>
                v === HANDOFF_QUEUE
                  ? t('handoffQueue')
                  : (members.find((m) => m.id === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={HANDOFF_QUEUE}>{t('handoffQueue')}</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t('handoffOnMissingInfo')}</p>
          <p className="text-xs text-muted-foreground">{t('handoffOnMissingInfoDesc')}</p>
        </div>
        <Switch
          checked={value.handoffOnMissingInfo}
          onCheckedChange={(v) => set('handoffOnMissingInfo', v)}
          disabled={disabled || !value.autoReplyEnabled}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={id('lead-pipeline')}>{t('leadPipeline')}</Label>
        <p className="text-xs text-muted-foreground">{t('leadPipelineDesc')}</p>
        <Select
          value={value.leadPipelineId || NO_LEAD_PIPELINE}
          onValueChange={(v) => set('leadPipelineId', !v || v === NO_LEAD_PIPELINE ? '' : v)}
          disabled={disabled}
        >
          <SelectTrigger id={id('lead-pipeline')}>
            <SelectValue>
              {(v: string) =>
                v === NO_LEAD_PIPELINE
                  ? t('leadPipelineNone')
                  : (pipelines.find((p) => p.id === v)?.label ?? v)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_LEAD_PIPELINE}>{t('leadPipelineNone')}</SelectItem>
            {pipelines.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
