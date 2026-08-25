'use client';

// ============================================================
// WidgetSettings — Channels → Widget web
//
// Lets an account admin turn the public web-chat widget on/off and
// copy the embed snippet for their own website. Reads/writes
// `accounts.widget_enabled` / `accounts.widget_key` directly — same
// pattern as DealsSettings (default_currency): `accounts_update` RLS
// (017) already restricts writes to admin+, so a non-admin sees a
// read-only, disabled view.
//
// The widget key is safe to show/copy openly: it only authorizes the
// one public "send a message, get an AI reply" endpoint (see
// migration 049's header comment) — nothing else.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, MessageSquareText, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

interface WidgetRow {
  widget_enabled: boolean;
  widget_key: string;
}

export function WidgetSettings() {
  const supabase = createClient();
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const t = useTranslations('Channels.widget');

  const [row, setRow] = useState<WidgetRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('accounts')
        .select('widget_enabled, widget_key')
        .eq('id', accountId)
        .single();
      if (cancelled) return;
      if (error) {
        console.error('[WidgetSettings] load error:', error);
        toast.error(t('loadFailed'));
        setLoading(false);
        return;
      }
      setRow(data as WidgetRow);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase, t]);

  async function handleToggle(next: boolean) {
    if (!accountId || !row) return;
    setSaving(true);
    const { error } = await supabase
      .from('accounts')
      .update({ widget_enabled: next })
      .eq('id', accountId);
    setSaving(false);
    if (error) {
      console.error('[WidgetSettings] toggle error:', error);
      toast.error(t('saveFailed'));
      return;
    }
    setRow({ ...row, widget_enabled: next });
    toast.success(next ? t('enabled') : t('disabled'));
  }

  async function handleRotate() {
    if (!accountId || !row) return;
    setRotating(true);
    const { data, error } = await supabase
      .from('accounts')
      .update({ widget_key: crypto.randomUUID() })
      .eq('id', accountId)
      .select('widget_enabled, widget_key')
      .single();
    setRotating(false);
    if (error || !data) {
      console.error('[WidgetSettings] rotate error:', error);
      toast.error(t('rotateFailed'));
      return;
    }
    setRow(data as WidgetRow);
    toast.success(t('rotated'));
  }

  async function copySnippet() {
    if (!row) return;
    try {
      await navigator.clipboard.writeText(snippetFor(row.widget_key));
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  if (loading || profileLoading || !row) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const snippet = snippetFor(row.widget_key);

  return (
    <section className="max-w-2xl animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <MessageSquareText className="size-4 text-primary" />
            {t('enableTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('enableDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <span className="text-sm text-foreground">
            {row.widget_enabled ? t('statusOn') : t('statusOff')}
          </span>
          <Switch
            checked={row.widget_enabled}
            disabled={!canEditSettings || saving}
            onCheckedChange={handleToggle}
          />
        </CardContent>
      </Card>

      {!canEditSettings && (
        <p className="text-xs text-muted-foreground">{t('adminOnlyHint')}</p>
      )}

      {row.widget_enabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('embedTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t.raw('embedDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-3 text-xs text-foreground">
              <code>{snippet}</code>
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={copySnippet}>
                <Copy className="size-4" />
                {t('copyCode')}
              </Button>
              {canEditSettings && (
                <Button type="button" variant="outline" onClick={handleRotate} disabled={rotating}>
                  {rotating ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {t('rotateKey')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t('rotateHint')}</p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function snippetFor(widgetKey: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `<script src="${origin}/widget.js" data-widget-key="${widgetKey}" async></script>`;
}
