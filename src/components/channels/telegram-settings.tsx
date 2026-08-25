'use client';

// ============================================================
// TelegramSettings — Channels → Notificaciones por Telegram
//
// Lets an account admin wire up a Telegram bot to receive a message
// every time the lead-form connector (see LeadFormSettings) captures
// a new lead. Telegram was chosen over WhatsApp for this notification
// specifically because it has no 24-hour re-engagement window — once
// the owner's chat has messaged the bot once, the bot can message it
// at any time (see src/lib/telegram/send.ts).
//
// The bot token is saved directly to `accounts.telegram_bot_token` via
// supabase-js (same RLS-gated pattern as the widget/lead-form toggles)
// rather than through an API route, since it's just a column write.
// The "Detectar chat" / "Enviar prueba" actions go through authenticated
// API routes instead, because Telegram's API doesn't send permissive
// CORS headers and can't be called directly from the browser.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Send, Sparkles, MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

interface TelegramRow {
  telegram_notify_enabled: boolean;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
}

export function TelegramSettings() {
  const supabase = createClient();
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const t = useTranslations('Channels.telegram');

  const [row, setRow] = useState<TelegramRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenInput, setTokenInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [chatName, setChatName] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('accounts')
        .select('telegram_notify_enabled, telegram_bot_token, telegram_chat_id')
        .eq('id', accountId)
        .single();
      if (cancelled) return;
      if (error) {
        console.error('[TelegramSettings] load error:', error);
        toast.error(t('loadFailed'));
        setLoading(false);
        return;
      }
      const loaded = data as TelegramRow;
      setRow(loaded);
      setTokenInput(loaded.telegram_bot_token ?? '');
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase, t]);

  async function handleSaveToken() {
    if (!accountId || !row) return;
    setSaving(true);
    const { data, error } = await supabase
      .from('accounts')
      .update({ telegram_bot_token: tokenInput.trim() || null, telegram_chat_id: null })
      .eq('id', accountId)
      .select('telegram_notify_enabled, telegram_bot_token, telegram_chat_id')
      .single();
    setSaving(false);
    if (error || !data) {
      console.error('[TelegramSettings] save token error:', error);
      toast.error(t('saveFailed'));
      return;
    }
    setRow(data as TelegramRow);
    setChatName(null);
    toast.success(t('tokenSaved'));
  }

  async function handleToggle(next: boolean) {
    if (!accountId || !row) return;
    setSaving(true);
    const { error } = await supabase
      .from('accounts')
      .update({ telegram_notify_enabled: next })
      .eq('id', accountId);
    setSaving(false);
    if (error) {
      console.error('[TelegramSettings] toggle error:', error);
      toast.error(t('saveFailed'));
      return;
    }
    setRow({ ...row, telegram_notify_enabled: next });
    toast.success(next ? t('enabled') : t('disabled'));
  }

  async function handleDetectChat() {
    if (!accountId) return;
    setDetecting(true);
    try {
      const res = await fetch('/api/telegram/detect-chat', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || t('detectFailed'));
        return;
      }
      const { error } = await supabase
        .from('accounts')
        .update({ telegram_chat_id: json.chat_id })
        .eq('id', accountId);
      if (error) {
        console.error('[TelegramSettings] persist chat id error:', error);
        toast.error(t('saveFailed'));
        return;
      }
      setRow((prev) => (prev ? { ...prev, telegram_chat_id: json.chat_id } : prev));
      setChatName(json.name);
      toast.success(t('detectSuccess', { name: json.name }));
    } catch (err) {
      console.error('[TelegramSettings] detect chat error:', err);
      toast.error(t('detectFailed'));
    } finally {
      setDetecting(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch('/api/telegram/test', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || t('testFailed'));
        return;
      }
      toast.success(t('testSuccess'));
    } catch (err) {
      console.error('[TelegramSettings] test error:', err);
      toast.error(t('testFailed'));
    } finally {
      setTesting(false);
    }
  }

  if (loading || profileLoading || !row) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  const hasToken = !!row.telegram_bot_token;
  const hasChat = !!row.telegram_chat_id;

  return (
    <section className="max-w-2xl animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <MessageCircle className="size-4 text-primary" />
            {t('botTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('botDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t('tokenPlaceholder')}
              disabled={!canEditSettings}
              className="max-w-sm"
            />
            {canEditSettings && (
              <Button type="button" variant="outline" onClick={handleSaveToken} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('saveToken')}
              </Button>
            )}
          </div>

          {hasToken && canEditSettings && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="button" variant="outline" onClick={handleDetectChat} disabled={detecting}>
                {detecting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {t('detectChat')}
              </Button>
              {hasChat && (
                <span className="text-xs text-muted-foreground">
                  {chatName ? t('chatDetectedAs', { name: chatName }) : t('chatDetected')}
                </span>
              )}
            </div>
          )}

          {hasChat && canEditSettings && (
            <div className="pt-1">
              <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {t('sendTest')}
              </Button>
            </div>
          )}

          {!canEditSettings && (
            <p className="text-xs text-muted-foreground">{t('adminOnlyHint')}</p>
          )}
        </CardContent>
      </Card>

      {hasToken && hasChat && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('enableTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">{t('enableDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <span className="text-sm text-foreground">
              {row.telegram_notify_enabled ? t('statusOn') : t('statusOff')}
            </span>
            <Switch
              checked={row.telegram_notify_enabled}
              disabled={!canEditSettings || saving}
              onCheckedChange={handleToggle}
            />
          </CardContent>
        </Card>
      )}
    </section>
  );
}
