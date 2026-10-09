'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Bot, CreditCard, LogIn, Loader2, Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { SettingsChip } from '@/components/settings/settings-chip';
import { AccountPlanDialog, PLAN_STATE_VARIANT } from './account-plan-dialog';
import type { PlanState } from '@/lib/plans/types';
import {
  AgentBehaviourForm,
  DEFAULT_AGENT_BEHAVIOUR,
  behaviourFromRow,
  behaviourToBody,
  type AgentBehaviour,
  type Option,
} from '@/components/settings/agent-behaviour-form';
import { ProviderModelFields, SecretInput } from './platform-ai-panel';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { enterAccount } from '@/lib/support/client';

type KeySource = 'own' | 'platform' | 'none';

interface AccountAiRow {
  id: string;
  name: string;
  configured: boolean;
  is_active: boolean;
  auto_reply_enabled: boolean;
  key_source: KeySource;
  monthly_runs: number;
  monthly_tokens: number;
  monthly_limit: number | null;
  plan_name: string | null;
  plan_state: PlanState;
  plan_expires_at: string | null;
}

const nf = new Intl.NumberFormat('es-DO');

/**
 * Super admin → Cuentas. Every account with its AI spend this month
 * (replies and tokens), its monthly limit and whose key it runs on, plus
 * "Editar agente" to manage any account's agent from here.
 */
export function AccountsAiPanel() {
  const t = useTranslations('SuperAdmin.accountsAi');
  const tPlan = useTranslations('Plan');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<AccountAiRow[]>([]);
  const [platformConfigured, setPlatformConfigured] = useState(true);
  const [limitsAvailable, setLimitsAvailable] = useState(true);
  const [editing, setEditing] = useState<AccountAiRow | null>(null);
  const [planFor, setPlanFor] = useState<AccountAiRow | null>(null);
  const [plansAvailable, setPlansAvailable] = useState(true);
  const [entering, setEntering] = useState<string | null>(null);
  const { accountId: currentAccountId } = useAuth();

  const enter = async (row: AccountAiRow) => {
    setEntering(row.id);
    const result = await enterAccount(row.id);
    if (!result.ok) {
      setEntering(null);
      toast.error(result.code === 'migration_pending' ? t('supportMigrationPending') : t('enterFailed'));
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/super-admin/accounts/ai', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRows(data.accounts ?? []);
      setPlatformConfigured(Boolean(data.platform_configured));
      setLimitsAvailable(data.limits_available !== false);
      setPlansAvailable(data.plans_available !== false);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const sourceLabel = (s: KeySource) =>
    s === 'own' ? t('sourceOwn') : s === 'platform' ? t('sourcePlatform') : t('sourceNone');

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!platformConfigured && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('noPlatformKey')}
        </p>
      )}
      {!limitsAvailable && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('migrationPending')}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </div>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">{t('colAccount')}</th>
                  <th className="px-4 py-3 font-medium">{t('colPlan')}</th>
                  <th className="px-4 py-3 font-medium">{t('colAgent')}</th>
                  <th className="px-4 py-3 font-medium">{t('colKey')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('colReplies')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('colTokens')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const over =
                    r.key_source === 'platform' &&
                    r.monthly_limit !== null &&
                    r.monthly_runs >= r.monthly_limit;
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium text-foreground">{r.name}</td>
                      <td className="px-4 py-3">
                        {r.plan_name ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-foreground">{r.plan_name}</span>
                            <SettingsChip variant={PLAN_STATE_VARIANT[r.plan_state]}>
                              {tPlan(`states.${r.plan_state}`)}
                            </SettingsChip>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">{t('noPlan')}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {!r.configured
                          ? t('agentNotSet')
                          : r.is_active
                            ? r.auto_reply_enabled
                              ? t('agentAuto')
                              : t('agentOn')
                            : t('agentOff')}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{sourceLabel(r.key_source)}</td>
                      <td
                        className={cn(
                          'px-4 py-3 text-right tabular-nums',
                          over ? 'font-semibold text-destructive' : 'text-foreground',
                        )}
                      >
                        {nf.format(r.monthly_runs)}
                        {r.key_source === 'platform' && r.monthly_limit !== null
                          ? ` / ${nf.format(r.monthly_limit)}`
                          : ''}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {nf.format(r.monthly_tokens)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-2">
                          {plansAvailable && (
                            <Button variant="outline" size="sm" onClick={() => setPlanFor(r)}>
                              <CreditCard className="mr-1.5 h-3.5 w-3.5" /> {t('planButton')}
                            </Button>
                          )}
                          <Button variant="outline" size="sm" onClick={() => setEditing(r)}>
                            <Pencil className="mr-1.5 h-3.5 w-3.5" /> {t('editAgent')}
                          </Button>
                          {r.id === currentAccountId ? (
                            <span className="inline-flex h-8 items-center px-2 text-xs text-muted-foreground">
                              {t('youAreHere')}
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => enter(r)}
                              disabled={entering !== null}
                            >
                              {entering === r.id ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <LogIn className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {t('enterAccount')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('usageNote')}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('supportNote')}</p>

      <AccountPlanDialog
        account={planFor}
        onClose={() => setPlanFor(null)}
        onChanged={() => void load()}
      />

      <AccountAgentDialog
        account={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

interface AccountAiDetail {
  account: { id: string; name: string };
  config: (Record<string, unknown> & { provider?: AiProvider; model?: string }) | null;
  key_source: KeySource;
  platform_configured: boolean;
  monthly_limit: number | null;
  monthly_used: number;
  members: { user_id: string; label: string }[];
  pipelines: { id: string; name: string }[];
}

function AccountAgentDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountAiRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('SuperAdmin.accountsAi');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<AccountAiDetail | null>(null);
  const [behaviour, setBehaviour] = useState<AgentBehaviour>(DEFAULT_AGENT_BEHAVIOUR);
  const [noLimit, setNoLimit] = useState(true);
  const [limit, setLimit] = useState('');
  // Own key: 'platform' runs on the platform key, 'own' on the account's.
  const [keyMode, setKeyMode] = useState<'platform' | 'own'>('platform');
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [ownKey, setOwnKey] = useState('');

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    void (async () => {
      try {
        const res = await fetch(`/api/super-admin/accounts/${account.id}/ai`, {
          cache: 'no-store',
        });
        const data = (await res.json()) as AccountAiDetail & { error?: string };
        if (!res.ok) throw new Error(data.error);
        if (cancelled) return;
        setDetail(data);
        setBehaviour(behaviourFromRow(data.config));
        setNoLimit(data.monthly_limit === null);
        setLimit(data.monthly_limit === null ? '' : String(data.monthly_limit));
        setKeyMode(data.key_source === 'own' ? 'own' : 'platform');
        setProvider(data.config?.provider ?? 'openai');
        setModel(data.config?.model ?? AI_PROVIDER_DEFAULT_MODEL.openai);
        setOwnKey('');
      } catch {
        toast.error(t('loadFailed'));
        onClose();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  const save = async () => {
    if (!detail) return;
    const body: Record<string, unknown> = { settings: behaviourToBody(behaviour) };
    if (noLimit) body.monthly_limit = null;
    else {
      const n = Number(limit);
      if (!Number.isFinite(n) || n < 0 || limit.trim() === '') {
        toast.error(t('invalidLimit'));
        return;
      }
      body.monthly_limit = Math.floor(n);
    }
    if (keyMode === 'platform' && detail.key_source === 'own') {
      body.own_key = null;
    } else if (keyMode === 'own' && ownKey.trim()) {
      body.own_key = { provider, model: model.trim(), api_key: ownKey.trim() };
    } else if (keyMode === 'own' && detail.key_source !== 'own') {
      toast.error(t('ownKeyMissing'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/super-admin/accounts/${detail.account.id}/ai`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saved'));
        onSaved();
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

  const members: Option[] = (detail?.members ?? []).map((m) => ({ id: m.user_id, label: m.label }));
  const pipelines: Option[] = (detail?.pipelines ?? []).map((p) => ({ id: p.id, label: p.name }));

  return (
    <Dialog open={!!account} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <Bot className="h-4 w-4 text-primary" /> {t('dialogTitle', { name: account?.name ?? '' })}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('dialogDesc')}</DialogDescription>
        </DialogHeader>

        {loading || !detail ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <div className="space-y-6">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">{t('limitTitle')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('limitDesc', { used: nf.format(detail.monthly_used) })}
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <Input
                  type="number"
                  min={0}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  disabled={saving || noLimit}
                  placeholder="500"
                  className="w-32"
                  aria-label={t('limitTitle')}
                />
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch checked={noLimit} onCheckedChange={setNoLimit} disabled={saving} />
                  {t('noLimit')}
                </label>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">{t('keyTitle')}</h3>
              <label className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{t('ownKeyToggle')}</span>
                  <span className="block text-xs text-muted-foreground">{t('ownKeyDesc')}</span>
                </span>
                <Switch
                  checked={keyMode === 'own'}
                  onCheckedChange={(v) => setKeyMode(v ? 'own' : 'platform')}
                  disabled={saving}
                />
              </label>
              {keyMode === 'own' && (
                <div className="space-y-4">
                  <ProviderModelFields
                    provider={provider}
                    model={model}
                    onProvider={setProvider}
                    onModel={setModel}
                    disabled={saving}
                    idPrefix="account-ai"
                  />
                  <div className="space-y-2">
                    <Label htmlFor="account-ai-key">{t('ownKey')}</Label>
                    <SecretInput
                      id="account-ai-key"
                      value={ownKey}
                      onChange={setOwnKey}
                      placeholder={detail.key_source === 'own' ? t('keepKeyPlaceholder') : 'sk-...'}
                      disabled={saving}
                    />
                    {detail.key_source === 'own' && (
                      <p className="text-xs text-muted-foreground">{t('ownKeyKeep')}</p>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">{t('agentTitle')}</h3>
              <AgentBehaviourForm
                value={behaviour}
                onChange={setBehaviour}
                members={members}
                pipelines={pipelines}
                disabled={saving}
                idPrefix="account-agent"
              />
              <p className="text-xs text-muted-foreground">{t('kbNote')}</p>
            </section>
          </div>
        )}

        <DialogFooter className="border-border bg-popover">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={save} disabled={saving || loading || !detail}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
