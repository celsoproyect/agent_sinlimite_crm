'use client';

// ============================================================
// LeadFormSettings — Channels → Formulario de leads
//
// Lets an account admin turn the public lead-form connector on/off
// and copy the POST contract for wiring an external form (e.g. one
// built in Lovable on the client's marketing site) into the CRM.
// Reads/writes `accounts.lead_form_enabled` / `accounts.lead_form_key`
// directly — same pattern as WidgetSettings.
//
// The lead-form key is safe to show/copy openly: it only authorizes
// the one public "submit a lead" endpoint (see migration 050's header
// comment) — nothing else. It is a SEPARATE key from the widget's, so
// either channel can be rotated independently.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, RefreshCw, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

interface LeadFormRow {
  lead_form_enabled: boolean;
  lead_form_key: string;
}

export function LeadFormSettings() {
  const supabase = createClient();
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const t = useTranslations('Channels.leadForm');

  const [row, setRow] = useState<LeadFormRow | null>(null);
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
        .select('lead_form_enabled, lead_form_key')
        .eq('id', accountId)
        .single();
      if (cancelled) return;
      if (error) {
        console.error('[LeadFormSettings] load error:', error);
        toast.error(t('loadFailed'));
        setLoading(false);
        return;
      }
      setRow(data as LeadFormRow);
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
      .update({ lead_form_enabled: next })
      .eq('id', accountId);
    setSaving(false);
    if (error) {
      console.error('[LeadFormSettings] toggle error:', error);
      toast.error(t('saveFailed'));
      return;
    }
    setRow({ ...row, lead_form_enabled: next });
    toast.success(next ? t('enabled') : t('disabled'));
  }

  async function handleRotate() {
    if (!accountId || !row) return;
    setRotating(true);
    const { data, error } = await supabase
      .from('accounts')
      .update({ lead_form_key: crypto.randomUUID() })
      .eq('id', accountId)
      .select('lead_form_enabled, lead_form_key')
      .single();
    setRotating(false);
    if (error || !data) {
      console.error('[LeadFormSettings] rotate error:', error);
      toast.error(t('rotateFailed'));
      return;
    }
    setRow(data as LeadFormRow);
    toast.success(t('rotated'));
  }

  async function copySnippet() {
    if (!row) return;
    try {
      await navigator.clipboard.writeText(snippetFor(row.lead_form_key));
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

  const snippet = snippetFor(row.lead_form_key);

  return (
    <section className="max-w-2xl animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <UserPlus className="size-4 text-primary" />
            {t('enableTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('enableDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <span className="text-sm text-foreground">
            {row.lead_form_enabled ? t('statusOn') : t('statusOff')}
          </span>
          <Switch
            checked={row.lead_form_enabled}
            disabled={!canEditSettings || saving}
            onCheckedChange={handleToggle}
          />
        </CardContent>
      </Card>

      {!canEditSettings && (
        <p className="text-xs text-muted-foreground">{t('adminOnlyHint')}</p>
      )}

      {row.lead_form_enabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('contractTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('contractDesc')}
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

function snippetFor(leadFormKey: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `POST ${origin}/api/leads/${leadFormKey}/submit
Content-Type: application/json

{
  "full_name": "Jane Doe",
  "email": "jane@example.com",
  "company": "Acme Inc",
  "service": "Consultoría",
  "employee_count": "11-50",
  "message": "Quiero más información"
}`;
}
