'use client';

// ============================================================
// WidgetAppearance — Canales → Widget web → Apariencia
//
// Edits accounts.widget_config (migration 060): what /widget.js draws on
// the client's website. Images go to the public `avatars` bucket under
// the editor's own folder (same RLS rule as profile photos, migration
// 008); only their public URLs are stored in the config.
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, ImagePlus, Loader2, Palette, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  DEFAULT_WIDGET_CONFIG,
  DEFAULT_WIDGET_ICON,
  WIDGET_LIMITS,
  normalizeWidgetConfig,
  type WidgetConfig,
} from '@/lib/widget/config';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif';

interface Props {
  widgetKey: string;
  canEdit: boolean;
}

export function WidgetAppearance({ widgetKey, canEdit }: Props) {
  const supabase = createClient();
  const { accountId, user } = useAuth();
  const t = useTranslations('Channels.widget');

  const [cfg, setCfg] = useState<WidgetConfig>(DEFAULT_WIDGET_CONFIG);
  const [loading, setLoading] = useState(true);
  const [missingColumn, setMissingColumn] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select('widget_config')
        .eq('id', accountId)
        .single();
      if (cancelled) return;
      if (error) {
        if (error.code === '42703') setMissingColumn(true);
        else console.error('[WidgetAppearance] load error:', error);
      } else {
        setCfg(normalizeWidgetConfig(data?.widget_config));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, supabase]);

  function patch(next: Partial<WidgetConfig>) {
    setCfg((prev) => ({ ...prev, ...next }));
  }

  async function handleSave() {
    if (!accountId) return;
    setSaving(true);
    const clean = normalizeWidgetConfig(cfg);
    const { data, error } = await supabase
      .from('accounts')
      .update({ widget_config: clean })
      .eq('id', accountId)
      .select('id');
    setSaving(false);
    if (error || !data?.length) {
      console.error('[WidgetAppearance] save error:', error);
      toast.error(error?.code === '42703' ? t('migrationMissing') : t('saveFailed'));
      return;
    }
    setCfg(clean);
    toast.success(t('saved'));
  }

  async function uploadImage(file: File, kind: 'avatar' | 'hero'): Promise<string | null> {
    if (!user) return null;
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error(t('imageTooBig'));
      return null;
    }
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const path = `${user.id}/widget-${kind}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from('avatars')
      .upload(path, file, { cacheControl: '3600', upsert: true, contentType: file.type });
    if (error) {
      toast.error(t('uploadFailed', { message: error.message }));
      return null;
    }
    return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="text-primary size-5 animate-spin" />
      </div>
    );
  }

  const disabled = !canEdit || missingColumn;
  const name = cfg.agentName || DEFAULT_WIDGET_CONFIG.agentName;
  const questions = cfg.quickQuestions;

  function setQuestion(i: number, next: Partial<{ icon: string; text: string }>) {
    patch({ quickQuestions: questions.map((q, j) => (j === i ? { ...q, ...next } : q)) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Palette className="size-4 text-primary" />
          {t('appearanceTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('appearanceDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {missingColumn && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            {t('migrationMissing')}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('agentName')}>
            <Input
              value={cfg.agentName}
              maxLength={WIDGET_LIMITS.agentName}
              disabled={disabled}
              onChange={(e) => patch({ agentName: e.target.value })}
            />
          </Field>
          <Field label={t('subtitle')}>
            <Input
              value={cfg.subtitle}
              maxLength={WIDGET_LIMITS.subtitle}
              placeholder={t('subtitlePlaceholder')}
              disabled={disabled}
              onChange={(e) => patch({ subtitle: e.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <ImageField
            label={t('avatar')}
            url={cfg.avatarUrl}
            round
            disabled={disabled}
            uploadLabel={t('upload')}
            removeLabel={t('remove')}
            onUpload={async (file) => {
              const url = await uploadImage(file, 'avatar');
              if (url) patch({ avatarUrl: url });
            }}
            onRemove={() => patch({ avatarUrl: null })}
          />
          <ImageField
            label={t('heroImage')}
            hint={t('heroHint')}
            url={cfg.heroImageUrl}
            disabled={disabled}
            uploadLabel={t('upload')}
            removeLabel={t('remove')}
            onUpload={async (file) => {
              const url = await uploadImage(file, 'hero');
              if (url) patch({ heroImageUrl: url });
            }}
            onRemove={() => patch({ heroImageUrl: null })}
          />
        </div>

        <Field label={t('welcomeTitle')}>
          <Input
            value={cfg.welcomeTitle}
            maxLength={WIDGET_LIMITS.welcomeTitle}
            placeholder={t('welcomeTitlePlaceholder', { name })}
            disabled={disabled}
            onChange={(e) => patch({ welcomeTitle: e.target.value })}
          />
        </Field>
        <Field label={t('welcomeText')}>
          <Textarea
            value={cfg.welcomeText}
            maxLength={WIDGET_LIMITS.welcomeText}
            rows={3}
            disabled={disabled}
            onChange={(e) => patch({ welcomeText: e.target.value })}
          />
        </Field>

        <div className="space-y-2">
          <Label className="text-foreground">{t('quickQuestions')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('quickQuestionsHint', { max: WIDGET_LIMITS.quickQuestions })}
          </p>
          {questions.map((q, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={t('iconLabel')}
                className="w-14 shrink-0 text-center"
                value={q.icon}
                maxLength={WIDGET_LIMITS.questionIcon}
                disabled={disabled}
                onChange={(e) => setQuestion(i, { icon: e.target.value })}
              />
              <Input
                className="min-w-0 flex-1"
                value={q.text}
                maxLength={WIDGET_LIMITS.questionText}
                placeholder={t('questionPlaceholder')}
                disabled={disabled}
                onChange={(e) => setQuestion(i, { text: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('remove')}
                disabled={disabled}
                onClick={() => patch({ quickQuestions: questions.filter((_, j) => j !== i) })}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          {questions.length < WIDGET_LIMITS.quickQuestions && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                patch({ quickQuestions: [...questions, { icon: DEFAULT_WIDGET_ICON, text: '' }] })
              }
            >
              <Plus className="size-4" />
              {t('addQuestion')}
            </Button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          <Field label={t('color')}>
            <div className="flex items-center gap-2">
              <input
                type="color"
                className="h-8 w-12 cursor-pointer rounded border border-input bg-transparent"
                value={cfg.primaryColor}
                disabled={disabled}
                onChange={(e) => patch({ primaryColor: e.target.value })}
              />
              <span className="font-mono text-xs text-muted-foreground">{cfg.primaryColor}</span>
            </div>
          </Field>
          <Field label={t('disclaimer')}>
            <Input
              value={cfg.disclaimer}
              maxLength={WIDGET_LIMITS.disclaimer}
              placeholder={t('disclaimerPlaceholder', { name })}
              disabled={disabled}
              onChange={(e) => patch({ disclaimer: e.target.value })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {canEdit && (
            <Button type="button" onClick={handleSave} disabled={saving || missingColumn}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              window.open(`/widget-preview.html?key=${encodeURIComponent(widgetKey)}`, '_blank', 'noopener')
            }
          >
            <ExternalLink className="size-4" />
            {t('preview')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('previewHint')}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-foreground">{label}</Label>
      {children}
    </div>
  );
}

function ImageField({
  label,
  hint,
  url,
  round,
  disabled,
  uploadLabel,
  removeLabel,
  onUpload,
  onRemove,
}: {
  label: string;
  hint?: string;
  url: string | null;
  round?: boolean;
  disabled: boolean;
  uploadLabel: string;
  removeLabel: string;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-foreground">{label}</Label>
      <div className="flex items-center gap-3">
        <div
          className={`flex size-16 shrink-0 items-center justify-center overflow-hidden border border-border bg-muted ${
            round ? 'rounded-full' : 'rounded-lg'
          }`}
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element -- user-uploaded, any host
            <img src={url} alt="" className={`size-full ${round ? 'object-cover' : 'object-contain'}`} />
          ) : (
            <ImagePlus className="size-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {uploadLabel}
          </Button>
          {url && (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRemove}>
              {removeLabel}
            </Button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={IMAGE_TYPES}
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            await onUpload(file);
            setBusy(false);
          }}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
