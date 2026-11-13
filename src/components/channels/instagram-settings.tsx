'use client';

// ============================================================
// InstagramSettings — Canales → Instagram (module `instagram`).
//
// Connects the account's Instagram professional account through
// Instagram's own login (/api/integrations/instagram/connect). Once
// connected, its DMs land in the inbox and the AI agent answers them
// (the switch below). The token is server-side only.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bot, Camera, Copy, Loader2, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

interface InstagramStatus {
  configured: boolean;
  migrationPending: boolean;
  connected: boolean;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
  aiEnabled: boolean;
  tokenExpiresAt: string | null;
  redirectUri: string;
  webhookUrl: string;
}

const RESULT_KEYS = ['connected', 'denied', 'error', 'forbidden', 'not_configured', 'migration', 'in_use'] as const;
type ResultKey = (typeof RESULT_KEYS)[number];

export function InstagramSettings() {
  const t = useTranslations('Channels.instagram');
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/instagram/status', { cache: 'no-store' });
      if (res.ok) {
        setStatus((await res.json()) as InstagramStatus);
        setLoadError(null);
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setLoadError(`${res.status}${body?.error ? ` · ${body.error}` : ''}`);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The OAuth callback comes back with ?instagram=<result>.
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('instagram') as ResultKey | null;
    if (!result || !RESULT_KEYS.includes(result)) return;
    if (result === 'connected') toast.success(t('result.connected'));
    else toast.error(t(`result.${result}`));
    url.searchParams.delete('instagram');
    window.history.replaceState(null, '', url.toString());
  }, [t]);

  async function handleDisconnect() {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setBusy(true);
    const res = await fetch('/api/integrations/instagram/disconnect', { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(t('disconnected'));
    void load();
  }

  async function handleToggleAi(next: boolean) {
    setBusy(true);
    const res = await fetch('/api/integrations/instagram/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_enabled: next }),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(t('saveFailed'));
      return;
    }
    setStatus((s) => (s ? { ...s, aiEnabled: next } : s));
  }

  function copy(text: string) {
    void navigator.clipboard?.writeText(text).then(() => toast.success(t('copied')));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }
  // Never vanish silently: a failed status call still shows the section,
  // with the reason, so the owner can tell what's wrong.
  if (!status) {
    return (
      <section className="max-w-2xl space-y-4">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
            <p className="text-sm text-amber-600">
              {t('loadFailed')} {loadError && <span className="text-muted-foreground">({loadError})</span>}
            </p>
            <Button type="button" variant="outline" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Camera className="size-4 text-primary" />
            {t('accountTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">{t('accountDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {status.migrationPending && <p className="text-sm text-amber-600">{t('migrationPending')}</p>}
          {!status.configured && <p className="text-sm text-amber-600">{t('notConfigured')}</p>}

          {status.connected ? (
            <div className="flex flex-wrap items-center gap-3">
              {status.profilePictureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={status.profilePictureUrl} alt="" className="size-10 rounded-full object-cover" />
              ) : (
                <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <Camera className="size-4 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {status.username ? `@${status.username}` : status.name}
                </p>
                <p className="text-xs text-muted-foreground">{t('connectedHint')}</p>
              </div>
              <Button type="button" variant="outline" onClick={handleDisconnect} disabled={busy}>
                <Unplug className="size-4" />
                {t('disconnect')}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              disabled={!status.configured || status.migrationPending}
              onClick={() => {
                window.location.href = '/api/integrations/instagram/connect';
              }}
            >
              <Camera className="size-4" />
              {t('connect')}
            </Button>
          )}
        </CardContent>
      </Card>

      {status.connected && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Bot className="size-4 text-primary" />
              {t('aiTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">{t('aiDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-foreground">{t('aiSwitch')}</span>
              <Switch checked={status.aiEnabled} onCheckedChange={handleToggleAi} disabled={busy} />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('setupTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('setupDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            { label: t('webhookUrl'), value: status.webhookUrl },
            { label: t('redirectUri'), value: status.redirectUri },
          ].map((row) => (
            <div key={row.label} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{row.label}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs text-foreground">
                  {row.value}
                </code>
                <Button type="button" variant="ghost" size="icon" onClick={() => copy(row.value)} aria-label={t('copy')}>
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t('windowNote')}</p>
        </CardContent>
      </Card>
    </section>
  );
}
