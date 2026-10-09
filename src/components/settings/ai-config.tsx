'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles, Gauge } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AiFaqCard } from './ai-faq';
import {
  AgentBehaviourForm,
  DEFAULT_AGENT_BEHAVIOUR,
  behaviourFromRow,
  behaviourToBody,
  type AgentBehaviour,
  type Option,
} from './agent-behaviour-form';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';

type KeySource = 'own' | 'platform' | 'none';

interface Status {
  keySource: KeySource;
  model: string | null;
  limit: number | null;
  used: number;
}

/**
 * Configuración → Agente de IA. The account's owner/admin runs their own
 * agent here: prompt, switches, handoff, lead capture, knowledge base and
 * FAQ. The AI itself (provider and key) is supplied by the platform, so
 * there are no key fields — only its status and this month's usage.
 */
export function AiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>({
    keySource: 'none',
    model: null,
    limit: null,
    used: 0,
  });
  const [hasEmbeddings, setHasEmbeddings] = useState(false);
  const [behaviour, setBehaviour] = useState<AgentBehaviour>(DEFAULT_AGENT_BEHAVIOUR);
  const [members, setMembers] = useState<Option[]>([]);
  const [pipelines, setPipelines] = useState<Option[]>([]);

  // Keyed on the account so an in-place account switch refetches.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setStatus({
        keySource: (data.key_source as KeySource) ?? 'none',
        model: data.configured ? data.model : null,
        limit: data.monthly_limit ?? null,
        used: data.monthly_used ?? 0,
      });
      setHasEmbeddings(Boolean(data.has_embeddings));
      setBehaviour(data.configured ? behaviourFromRow(data) : { ...DEFAULT_AGENT_BEHAVIOUR });
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    void fetchAccountMembers().then((list) =>
      setMembers(list.map((m) => ({ id: m.user_id, label: memberLabel(m) }))),
    );
    void createClient()
      .from('pipelines')
      .select('id, name')
      .order('name')
      .then(({ data }) =>
        setPipelines(
          ((data as { id: string; name: string }[] | null) ?? []).map((p) => ({
            id: p.id,
            label: p.name,
          })),
        ),
      );
  }, [accountId, fetchConfig]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(behaviourToBody(behaviour)),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else if (data.code === 'migration_pending') {
        toast.error(t('migrationPending'));
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const pct =
    status.limit && status.limit > 0
      ? Math.min(100, Math.round((status.used / status.limit) * 100))
      : 0;
  const exceeded = status.limit !== null && status.used >= status.limit;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> {t('statusTitle')}
            </CardTitle>
            <CardDescription>
              {status.keySource === 'none'
                ? t('statusNone')
                : status.keySource === 'own'
                  ? t('statusOwn')
                  : t('statusPlatform')}
            </CardDescription>
          </CardHeader>
          {status.keySource === 'platform' && (
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Gauge className="h-4 w-4" /> {t('usageThisMonth')}
                </span>
                <span className="font-medium tabular-nums text-foreground">
                  {status.limit === null
                    ? t('usageNoLimit', { used: status.used })
                    : t('usageOfLimit', { used: status.used, limit: status.limit })}
                </span>
              </div>
              {status.limit !== null && (
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full', exceeded ? 'bg-destructive' : 'bg-primary')}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              {exceeded && <p className="text-xs text-destructive">{t('limitReached')}</p>}
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>{t('behaviourDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <AgentBehaviourForm
              value={behaviour}
              onChange={setBehaviour}
              members={members}
              pipelines={pipelines}
              disabled={disabled}
            />
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>

        <AiKnowledgeCard accountId={accountId} canEdit={canEdit} hasEmbeddingsKey={hasEmbeddings} />

        <AiFaqCard accountId={accountId} canEdit={canEdit} />
      </div>
    </div>
  );
}
