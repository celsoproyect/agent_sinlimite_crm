'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { SettingsChip } from '@/components/settings/settings-chip';
import { MODULE_META } from './modules-panel';
import { MODULE_KEYS, isModuleEnabled, type EnabledModules } from '@/lib/modules';
import {
  PLAN_LIMIT_COLUMN,
  PLAN_RESOURCES,
  type BillingInterval,
  type Plan,
} from '@/lib/plans/types';

interface PlanRow extends Plan {
  account_count: number;
}

export function formatMoney(price: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(price);
  } catch {
    return `${price} ${currency}`;
  }
}

/**
 * Super admin → Planes (migration 074). The plans sold to clients: price,
 * limits (blank = unlimited) and the modules each one includes. Accounts
 * get a plan in Cuentas y consumo → Plan.
 */
export function PlansPanel() {
  const t = useTranslations('SuperAdmin.plans');
  const tPlan = useTranslations('Plan');
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [migrated, setMigrated] = useState(true);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [editing, setEditing] = useState<PlanRow | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/super-admin/plans', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPlans(data.plans ?? []);
      setMigrated(data.migrated !== false);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const n = (v: number) => new Intl.NumberFormat(locale).format(v);

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          migrated ? (
            <Button onClick={() => setEditing('new')}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('newPlan')}
            </Button>
          ) : null
        }
      />

      {!migrated && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('migrationPending')}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </div>
      ) : migrated && plans.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">{t('empty')}</Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((p) => {
            const included = MODULE_KEYS.filter((k) => isModuleEnabled(p.modules, k)).length;
            return (
              <Card key={p.id} className="gap-3 p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-foreground">{p.name}</h3>
                    <p className="text-sm text-foreground">
                      {tPlan('pricePer', {
                        price: formatMoney(p.price, p.currency, locale),
                        interval: tPlan(`interval.${p.billing_interval}`),
                      })}
                    </p>
                  </div>
                  {!p.is_active && <SettingsChip variant="muted">{t('inactive')}</SettingsChip>}
                </div>
                {p.description ? (
                  <p className="text-sm text-muted-foreground">{p.description}</p>
                ) : null}
                <ul className="space-y-1 text-sm">
                  {PLAN_RESOURCES.map((r) => {
                    const v = p[PLAN_LIMIT_COLUMN[r]];
                    return (
                      <li key={r} className="flex flex-wrap justify-between gap-x-3">
                        <span className="text-muted-foreground">{tPlan(`resources.${r}`)}</span>
                        <span className="tabular-nums text-foreground">
                          {v === null ? tPlan('unlimited') : n(v)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {t('modulesCount', { count: included, total: MODULE_KEYS.length })} ·{' '}
                  {t('accountsCount', { count: p.account_count })}
                </p>
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> {t('edit')}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <PlanDialog
        plan={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    </div>
  );
}

interface PlanDraft {
  name: string;
  description: string;
  price: string;
  currency: string;
  billing_interval: BillingInterval;
  limits: Record<string, string>;
  modules: EnabledModules;
  is_active: boolean;
  sort_order: string;
}

function draftFrom(plan: PlanRow | null): PlanDraft {
  const limits: Record<string, string> = {};
  for (const r of PLAN_RESOURCES) {
    const column = PLAN_LIMIT_COLUMN[r];
    const v = plan ? plan[column] : null;
    limits[column] = v === null ? '' : String(v);
  }
  const modules: EnabledModules = {};
  for (const k of MODULE_KEYS) modules[k] = isModuleEnabled(plan?.modules ?? {}, k);
  return {
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    price: plan ? String(plan.price) : '',
    currency: plan?.currency ?? 'USD',
    billing_interval: plan?.billing_interval ?? 'month',
    limits,
    modules,
    is_active: plan?.is_active ?? true,
    sort_order: plan ? String(plan.sort_order) : '0',
  };
}

function PlanDialog({
  plan,
  onClose,
  onSaved,
}: {
  plan: PlanRow | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('SuperAdmin.plans');
  const tPlan = useTranslations('Plan');
  const tSidebar = useTranslations('Sidebar');
  const existing = plan && plan !== 'new' ? plan : null;
  const [draft, setDraft] = useState<PlanDraft>(() => draftFrom(existing));
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the form each time the dialog opens on a plan.
  const [openedFor, setOpenedFor] = useState<PlanRow | 'new' | null>(null);
  if (plan !== openedFor) {
    setOpenedFor(plan);
    if (plan) {
      setDraft(draftFrom(existing));
      setConfirmDelete(false);
    }
  }

  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error(t('nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        price: draft.price === '' ? 0 : Number(draft.price),
        currency: draft.currency,
        billing_interval: draft.billing_interval,
        ...draft.limits,
        modules: draft.modules,
        is_active: draft.is_active,
        sort_order: Number(draft.sort_order) || 0,
      };
      const res = await fetch(
        existing ? `/api/super-admin/plans/${existing.id}` : '/api/super-admin/plans',
        {
          method: existing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error);
      toast.success(t('saved'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/super-admin/plans/${existing.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success(t('deleted'));
      onSaved();
    } catch {
      toast.error(t('deleteFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? t('editTitle') : t('newTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="plan-name">{t('name')}</Label>
              <Input
                id="plan-name"
                value={draft.name}
                maxLength={80}
                onChange={(e) => set('name', e.target.value)}
                placeholder={t('namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="plan-desc">{t('descriptionLabel')}</Label>
              <Textarea
                id="plan-desc"
                rows={2}
                maxLength={500}
                value={draft.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-price">{t('price')}</Label>
              <Input
                id="plan-price"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={draft.price}
                onChange={(e) => set('price', e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="plan-currency">{t('currency')}</Label>
                <Input
                  id="plan-currency"
                  maxLength={3}
                  value={draft.currency}
                  onChange={(e) => set('currency', e.target.value.toUpperCase())}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('interval')}</Label>
                <Select
                  value={draft.billing_interval}
                  onValueChange={(v) => set('billing_interval', v as BillingInterval)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month">{t('monthly')}</SelectItem>
                    <SelectItem value="year">{t('yearly')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">{t('limitsTitle')}</h4>
            <p className="text-xs text-muted-foreground">{t('limitsHint')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {PLAN_RESOURCES.map((r) => {
                const column = PLAN_LIMIT_COLUMN[r];
                return (
                  <div key={r} className="space-y-1.5">
                    <Label htmlFor={`plan-${column}`}>{tPlan(`resources.${r}`)}</Label>
                    <Input
                      id={`plan-${column}`}
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      placeholder={tPlan('unlimited')}
                      value={draft.limits[column]}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          limits: { ...d.limits, [column]: e.target.value },
                        }))
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">{t('modulesTitle')}</h4>
            <p className="text-xs text-muted-foreground">{t('modulesHint')}</p>
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {MODULE_KEYS.map((key) => {
                const meta = MODULE_META[key];
                const Icon = meta.icon;
                return (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      {tSidebar(meta.labelKey)}
                    </span>
                    <Switch
                      checked={draft.modules[key] ?? false}
                      onCheckedChange={(v) =>
                        setDraft((d) => ({ ...d, modules: { ...d.modules, [key]: !!v } }))
                      }
                    />
                  </label>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span className="text-sm text-foreground">{t('active')}</span>
              <Switch checked={draft.is_active} onCheckedChange={(v) => set('is_active', !!v)} />
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="plan-order">{t('sortOrder')}</Label>
              <Input
                id="plan-order"
                type="number"
                step={1}
                value={draft.sort_order}
                onChange={(e) => set('sort_order', e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          {existing ? (
            confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('deleteConfirm', { count: existing.account_count })}
                </span>
                <Button variant="destructive" size="sm" onClick={remove} disabled={saving}>
                  {t('deleteYes')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={saving}>
                <Trash2 className="mr-1.5 h-4 w-4" /> {t('delete')}
              </Button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
