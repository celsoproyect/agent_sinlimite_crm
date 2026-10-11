'use client';

// ============================================================
// AssignmentSettingsCard — Configuración → Miembros del equipo
// (module `auto_assign`, migration 076).
//
// How chats reach the team when the AI hands a customer over: the mode
// (round robin, a fixed sequence or least busy), who is in the
// rotation and in what order, each person's "Disponible" switch, the
// minutes before an unanswered chat moves on, and whether new chats are
// assigned while the AI isn't answering. Admins edit; everyone else
// sees it read-only.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Loader2, Save, Shuffle } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { isModuleEnabled } from '@/lib/modules';
import { cn } from '@/lib/utils';
import {
  ASSIGNMENT_MODES,
  DEFAULT_REASSIGN_MINUTES,
  MAX_REASSIGN_MINUTES,
  MIN_REASSIGN_MINUTES,
  type AssignmentMode,
  type AssignmentSettings,
} from '@/lib/assignment/settings';

interface TeamMember {
  user_id: string;
  full_name: string;
  role: string;
  is_available: boolean;
}

/** The rotation as a full ordered list: the saved order first, then
 *  everyone else (unchecked unless the saved list is empty = everyone). */
function orderedTeam(members: TeamMember[], saved: string[]): { member: TeamMember; included: boolean }[] {
  const byId = new Map(members.map((m) => [m.user_id, m]));
  const first = saved.map((id) => byId.get(id)).filter((m): m is TeamMember => !!m);
  const rest = members.filter((m) => !saved.includes(m.user_id));
  return [
    ...first.map((member) => ({ member, included: true })),
    ...rest.map((member) => ({ member, included: saved.length === 0 })),
  ];
}

export function AssignmentSettingsCard() {
  const t = useTranslations('Assignment');
  const { account } = useAuth();
  const canEdit = useCan('manage-members');
  const moduleOn = isModuleEnabled(account?.enabled_modules, 'auto_assign');

  const [loading, setLoading] = useState(true);
  const [migrated, setMigrated] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<AssignmentMode>('off');
  const [rows, setRows] = useState<{ member: TeamMember; included: boolean }[]>([]);
  const [neverMove, setNeverMove] = useState(false);
  const [minutes, setMinutes] = useState(String(DEFAULT_REASSIGN_MINUTES));
  const [whenAiOff, setWhenAiOff] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/assignment');
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        migrated: boolean;
        settings: AssignmentSettings;
        members: TeamMember[];
      };
      setMigrated(data.migrated);
      setMode(data.settings.mode);
      setRows(orderedTeam(data.members, data.settings.members));
      setNeverMove(data.settings.reassign_minutes === null);
      setMinutes(String(data.settings.reassign_minutes ?? DEFAULT_REASSIGN_MINUTES));
      setWhenAiOff(data.settings.assign_when_ai_off);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (moduleOn) void load();
  }, [moduleOn, load]);

  if (!moduleOn) return null;

  const move = (index: number, delta: number) => {
    setRows((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const toggleIncluded = (userId: string, included: boolean) => {
    setRows((prev) => prev.map((r) => (r.member.user_id === userId ? { ...r, included } : r)));
  };

  const toggleAvailable = async (userId: string, available: boolean) => {
    setTogglingId(userId);
    try {
      const res = await fetch('/api/account/availability', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, is_available: available }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setRows((prev) =>
        prev.map((r) => (r.member.user_id === userId ? { ...r, member: { ...r.member, is_available: available } } : r)),
      );
    } catch {
      toast.error(t('availabilityFailed'));
    } finally {
      setTogglingId(null);
    }
  };

  const save = async () => {
    const included = rows.filter((r) => r.included).map((r) => r.member.user_id);
    if (mode !== 'off' && included.length === 0) {
      toast.error(t('nobodySelected'));
      return;
    }
    const parsed = Number(minutes);
    if (!neverMove && (!Number.isFinite(parsed) || parsed < MIN_REASSIGN_MINUTES || parsed > MAX_REASSIGN_MINUTES)) {
      toast.error(t('minutesInvalid', { min: MIN_REASSIGN_MINUTES, max: MAX_REASSIGN_MINUTES }));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/account/assignment', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          // Everyone checked (outside a sequence, where order matters) is
          // saved as "everyone", so people who join later are included.
          members: included.length === rows.length && mode !== 'sequence' ? [] : included,
          reassign_minutes: neverMove ? null : Math.round(parsed),
          assign_when_ai_off: whenAiOff,
        }),
      });
      if (res.status === 503) {
        toast.error(t('notMigrated'));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-4">
      <CardContent className="space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Shuffle className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !migrated ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{t('notMigrated')}</p>
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('modeLabel')}</h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ASSIGNMENT_MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default',
                      mode === m ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/60',
                    )}
                  >
                    <span className="block text-sm font-medium text-foreground">{t(`modes.${m}.label`)}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t(`modes.${m}.help`)}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('teamLabel')}</h3>
              <p className="text-xs text-muted-foreground">{mode === 'sequence' ? t('teamHelpSequence') : t('teamHelp')}</p>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noTeam')}</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {rows.map((row, i) => (
                    <li key={row.member.user_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <Checkbox
                        checked={row.included}
                        disabled={!canEdit}
                        onCheckedChange={(v) => toggleIncluded(row.member.user_id, v === true)}
                        aria-label={t('includeLabel', { name: row.member.full_name })}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {mode === 'sequence' && row.included && (
                            <span className="mr-1.5 tabular-nums text-muted-foreground">
                              {rows.slice(0, i + 1).filter((r) => r.included).length}.
                            </span>
                          )}
                          {row.member.full_name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {row.member.is_available ? t('available') : t('away')}
                        </p>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t('availableSwitch')}
                        <Switch
                          checked={row.member.is_available}
                          disabled={!canEdit || togglingId === row.member.user_id}
                          onCheckedChange={(v) => void toggleAvailable(row.member.user_id, v)}
                        />
                      </label>
                      {canEdit && mode === 'sequence' && (
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                            aria-label={t('moveUp')}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={i === rows.length - 1}
                            onClick={() => move(i, 1)}
                            aria-label={t('moveDown')}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('reassignLabel')}</h3>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={MIN_REASSIGN_MINUTES}
                    max={MAX_REASSIGN_MINUTES}
                    value={minutes}
                    disabled={!canEdit || neverMove}
                    onChange={(e) => setMinutes(e.target.value)}
                    className="w-24"
                    aria-label={t('reassignLabel')}
                  />
                  <span className="text-sm text-muted-foreground">{t('minutes')}</span>
                </div>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Switch checked={neverMove} disabled={!canEdit} onCheckedChange={setNeverMove} />
                  {t('neverMove')}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{t('reassignHelp')}</p>
            </section>

            <label className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{t('whenAiOff')}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t('whenAiOffHelp')}</span>
              </span>
              <Switch checked={whenAiOff} disabled={!canEdit} onCheckedChange={setWhenAiOff} />
            </label>

            <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{t('aiNote')}</p>

            {canEdit && (
              <div className="flex justify-end">
                <Button onClick={save} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {t('save')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
