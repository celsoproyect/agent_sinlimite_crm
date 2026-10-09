'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarPlus, Loader2, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsChip, type ChipVariant } from '@/components/settings/settings-chip';
import { UsageBar } from '@/components/plans/usage-bar';
import { MODULE_META } from './modules-panel';
import { formatMoney } from './plans-panel';
import { BUSINESS_TIME_ZONE, businessDate, businessToday } from '@/lib/business-timezone';
import { MODULE_KEYS, isModuleKey, type ModuleKey } from '@/lib/modules';
import {
  PLAN_RESOURCES,
  PLAN_STATUSES,
  type AccountExtra,
  type ExtraResource,
  type Limits,
  type Plan,
  type PlanState,
  type PlanStatus,
  type Usage,
} from '@/lib/plans/types';

export const PLAN_STATE_VARIANT: Record<PlanState, ChipVariant> = {
  none: 'muted',
  trial: 'warn',
  active: 'ok',
  expiring: 'warn',
  past_due: 'danger',
  suspended: 'danger',
};

interface AccountPlanPayload {
  migrated: boolean;
  account: { id: string; name: string };
  plan: Plan | null;
  status: PlanStatus;
  expires_at: string | null;
  state: PlanState;
  extras: AccountExtra[];
  limits: Limits;
  usage: Usage;
  plans: Plan[];
}

const NO_PLAN = '__none__';

/** The last business day an expiry instant covers (it is stored as the next midnight). */
function paidThroughDay(expiresAt: string): string {
  return businessDate(new Date(new Date(expiresAt).getTime() - 1));
}

/**
 * Super admin → Cuentas y consumo → Plan: one account's plan, status,
 * paid-up date, usage and extras (migration 074).
 */
export function AccountPlanDialog({
  account,
  onClose,
  onChanged,
}: {
  account: { id: string; name: string } | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('SuperAdmin.accountPlan');
  const tPlan = useTranslations('Plan');
  const tSidebar = useTranslations('Sidebar');
  const locale = useLocale();
  const [data, setData] = useState<AccountPlanPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expiresOn, setExpiresOn] = useState('');

  const apply = useCallback((payload: AccountPlanPayload) => {
    setData(payload);
    setExpiresOn(payload.expires_at ? paidThroughDay(payload.expires_at) : '');
  }, []);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/super-admin/accounts/${account.id}/plan`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      apply(body);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [account, apply, t]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    if (!account) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/super-admin/accounts/${account.id}/plan`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error);
      apply(json);
      toast.success(t('saved'));
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const removeExtra = async (extraId: string) => {
    if (!account) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/super-admin/accounts/${account.id}/extras/${extraId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error();
      toast.success(t('extraRemoved'));
      await load();
      onChanged();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: BUSINESS_TIME_ZONE,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));

  const extraLabel = (e: AccountExtra) =>
    e.resource === 'module'
      ? tPlan('extraModule', {
          name:
            e.module_key && isModuleKey(e.module_key)
              ? tSidebar(MODULE_META[e.module_key].labelKey)
              : (e.module_key ?? ''),
        })
      : tPlan('extraResource', {
          quantity: new Intl.NumberFormat(locale).format(e.quantity),
          resource: tPlan(`resourceShort.${e.resource}`),
        });

  return (
    <Dialog open={account !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title', { name: account?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loading && !data ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {tPlan('loading')}
          </div>
        ) : !data ? null : !data.migrated ? (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {t('migrationPending')}
          </p>
        ) : (
          <div className="space-y-6">
            {/* Plan, status and paid-up date */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-foreground">{t('planTitle')}</h4>
                <SettingsChip variant={PLAN_STATE_VARIANT[data.state]}>
                  {tPlan(`states.${data.state}`)}
                </SettingsChip>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t('plan')}</Label>
                  <Select
                    value={data.plan?.id ?? NO_PLAN}
                    disabled={saving}
                    onValueChange={(v) => void patch({ plan_id: v === NO_PLAN ? null : v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PLAN}>{t('noPlan')}</SelectItem>
                      {data.plans.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} · {formatMoney(p.price, p.currency, locale)}
                          {p.is_active ? '' : ` (${t('inactive')})`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t('status')}</Label>
                  <Select
                    value={data.status}
                    disabled={saving || !data.plan}
                    onValueChange={(v) => void patch({ plan_status: v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLAN_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {t(`statuses.${s}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {data.plan ? (
                <div className="space-y-1.5">
                  <Label htmlFor="plan-expires">{t('paidUntil')}</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="plan-expires"
                      type="date"
                      className="w-auto"
                      value={expiresOn}
                      onChange={(e) => setExpiresOn(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        saving ||
                        expiresOn === (data.expires_at ? paidThroughDay(data.expires_at) : '')
                      }
                      onClick={() => void patch({ expires_on: expiresOn || null })}
                    >
                      {t('saveDate')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={saving}
                      onClick={() => void patch({ pay: 'month' })}
                    >
                      <CalendarPlus className="mr-1.5 h-3.5 w-3.5" /> {t('payMonth')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={() => void patch({ pay: 'year' })}
                    >
                      {t('payYear')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {data.expires_at
                      ? t('paidUntilHint', { date: day(paidThroughDay(data.expires_at) + 'T12:00:00Z') })
                      : t('noDateHint')}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('noPlanHint')}</p>
              )}
            </section>

            {/* Usage */}
            <section className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">{tPlan('usageTitle')}</h4>
              {PLAN_RESOURCES.map((r) => (
                <UsageBar
                  key={r}
                  label={tPlan(`resources.${r}`)}
                  used={data.usage[r]}
                  limit={data.limits[r]}
                />
              ))}
            </section>

            {/* Extras */}
            <section className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">{tPlan('extrasTitle')}</h4>
              {data.extras.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noExtras')}</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {data.extras.map((e) => {
                    const expired = e.expires_at !== null && new Date(e.expires_at) <= new Date();
                    return (
                      <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className={expired ? 'text-muted-foreground line-through' : 'text-foreground'}>
                            {extraLabel(e)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {e.expires_at
                              ? tPlan('extraUntil', { date: day(paidThroughDay(e.expires_at) + 'T12:00:00Z') })
                              : tPlan('extraPermanent')}
                            {e.note ? ` · ${e.note}` : ''}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('removeExtra')}
                          disabled={saving}
                          onClick={() => void removeExtra(e.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <AddExtraForm
                accountId={data.account.id}
                onAdded={() => {
                  void load();
                  onChanged();
                }}
              />
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type Duration = 'permanent' | 'month' | 'until';

function AddExtraForm({ accountId, onAdded }: { accountId: string; onAdded: () => void }) {
  const t = useTranslations('SuperAdmin.accountPlan');
  const tPlan = useTranslations('Plan');
  const tSidebar = useTranslations('Sidebar');
  const [resource, setResource] = useState<ExtraResource>('ai_replies');
  const [moduleKey, setModuleKey] = useState<ModuleKey>(MODULE_KEYS[0]);
  const [quantity, setQuantity] = useState('');
  const [duration, setDuration] = useState<Duration>('permanent');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const add = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/super-admin/accounts/${accountId}/extras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resource,
          quantity: resource === 'module' ? undefined : Number(quantity),
          module_key: resource === 'module' ? moduleKey : undefined,
          duration,
          until: duration === 'until' ? until : undefined,
          note,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error);
      toast.success(t('extraAdded'));
      setQuantity('');
      setNote('');
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const invalid =
    (resource !== 'module' && !(Number(quantity) > 0)) || (duration === 'until' && !until);

  return (
    <div className="space-y-3 rounded-md border border-dashed border-border p-3">
      <p className="text-sm font-medium text-foreground">{t('addExtra')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t('extraWhat')}</Label>
          <Select value={resource} onValueChange={(v) => setResource(v as ExtraResource)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_RESOURCES.map((r) => (
                <SelectItem key={r} value={r}>
                  {tPlan(`resources.${r}`)}
                </SelectItem>
              ))}
              <SelectItem value="module">{t('extraModuleOption')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {resource === 'module' ? (
          <div className="space-y-1.5">
            <Label>{t('extraModuleLabel')}</Label>
            <Select value={moduleKey} onValueChange={(v) => setModuleKey(v as ModuleKey)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODULE_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {tSidebar(MODULE_META[k].labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="extra-qty">{t('extraQuantity')}</Label>
            <Input
              id="extra-qty"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label>{t('extraDuration')}</Label>
          <Select value={duration} onValueChange={(v) => setDuration(v as Duration)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="permanent">{t('durationPermanent')}</SelectItem>
              <SelectItem value="month">{t('durationMonth')}</SelectItem>
              <SelectItem value="until">{t('durationUntil')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {duration === 'until' ? (
          <div className="space-y-1.5">
            <Label htmlFor="extra-until">{t('extraUntilLabel')}</Label>
            <Input
              id="extra-until"
              type="date"
              min={businessToday()}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="extra-note">{t('extraNote')}</Label>
          <Input
            id="extra-note"
            maxLength={200}
            value={note}
            placeholder={t('extraNotePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={add} disabled={saving || invalid}>
          {saving ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('addExtraButton')}
        </Button>
      </div>
    </div>
  );
}
