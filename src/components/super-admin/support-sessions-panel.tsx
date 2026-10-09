'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, RefreshCw, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { BUSINESS_TIME_ZONE } from '@/lib/business-timezone';
import { formatDuration } from '@/lib/support/format';
import { cn } from '@/lib/utils';

interface SupportSessionRow {
  id: string;
  account_id: string;
  account_name: string;
  user_name: string;
  user_email: string | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * Super admin → Soporte. The support-mode audit log (migration 073):
 * every visit to a client account, who made it and for how long.
 */
export function SupportSessionsPanel() {
  const t = useTranslations('SuperAdmin.support');
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<SupportSessionRow[]>([]);
  const [migrated, setMigrated] = useState(true);
  const [search, setSearch] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/super-admin/support/sessions', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRows(data.sessions ?? []);
      setMigrated(data.migrated !== false);
      setNowIso(new Date().toISOString());
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const when = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone: BUSINESS_TIME_ZONE,
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!openOnly || !r.ended_at) &&
        (!q ||
          r.account_name.toLowerCase().includes(q) ||
          r.user_name.toLowerCase().includes(q) ||
          (r.user_email ?? '').toLowerCase().includes(q)),
    );
  }, [rows, search, openOnly]);

  const openCount = rows.filter((r) => !r.ended_at).length;
  const accountCount = new Set(rows.map((r) => r.account_id)).size;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!migrated && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('migrationPending')}
        </p>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label={t('statVisits')} value={rows.length} />
        <Stat label={t('statAccounts')} value={accountCount} />
        <Stat label={t('statOpen')} value={openCount} highlight={openCount > 0} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="support-open-only" checked={openOnly} onCheckedChange={setOpenOnly} />
          <Label htmlFor="support-open-only" className="text-sm">
            {t('openOnly')}
          </Label>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          {t('refresh')}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </div>
      ) : visible.length === 0 ? (
        <Card className="px-4 py-10 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? t('empty') : t('noMatches')}
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">{t('colAccount')}</th>
                  <th className="px-4 py-3 font-medium">{t('colWho')}</th>
                  <th className="px-4 py-3 font-medium">{t('colStarted')}</th>
                  <th className="px-4 py-3 font-medium">{t('colEnded')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('colDuration')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-medium text-foreground">{r.account_name}</td>
                    <td className="px-4 py-3">
                      <div className="text-foreground">{r.user_name}</div>
                      {r.user_email && r.user_email !== r.user_name && (
                        <div className="text-xs text-muted-foreground">{r.user_email}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {when.format(new Date(r.started_at))}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {r.ended_at ? (
                        when.format(new Date(r.ended_at))
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                          {t('insideNow')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {formatDuration(r.started_at, r.ended_at ?? nowIso)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('note')}</p>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          highlight ? 'text-primary' : 'text-foreground',
        )}
      >
        {value}
      </div>
    </Card>
  );
}
