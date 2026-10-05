'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Trash2, Upload } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { DEFAULT_BRANDING } from '@/lib/branding';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

export function BrandingPanel() {
  const t = useTranslations('SuperAdmin.branding');
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [companyName, setCompanyName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [logoUrl, setLogoUrl] = useState<string>(DEFAULT_BRANDING.logoUrl);
  const [logoLightUrl, setLogoLightUrl] = useState<string | null>(null);
  const [savedLightUrl, setSavedLightUrl] = useState<string | null>(null);
  const [pendingDark, setPendingDark] = useState<File | null>(null);
  const [pendingLight, setPendingLight] = useState<File | null>(null);
  // false until migration 061 adds platform_settings.logo_light_url.
  const [lightSupported, setLightSupported] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let { data, error } = await supabase
        .from('platform_settings')
        .select('company_name, logo_url, logo_light_url')
        .eq('id', true)
        .maybeSingle();
      if (error?.code === '42703') {
        if (!cancelled) setLightSupported(false);
        ({ data, error } = await supabase
          .from('platform_settings')
          .select('company_name, logo_url')
          .eq('id', true)
          .maybeSingle());
      }
      if (cancelled) return;
      if (!error && data) {
        const row = data as {
          company_name: string | null;
          logo_url: string | null;
          logo_light_url?: string | null;
        };
        const name = row.company_name || DEFAULT_BRANDING.companyName;
        setCompanyName(name);
        setSavedName(name);
        setLogoUrl(row.logo_url || DEFAULT_BRANDING.logoUrl);
        setLogoLightUrl(row.logo_light_url || null);
        setSavedLightUrl(row.logo_light_url || null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadLogo = async (file: File, kind: 'dark' | 'light') => {
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const path = `logo-${kind}-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('branding')
      .upload(path, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type,
      });
    if (uploadError) throw new Error(uploadError.message);
    return supabase.storage.from('branding').getPublicUrl(path).data.publicUrl;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = companyName.trim();
    if (!trimmedName) {
      toast.error(t('nameRequired'));
      return;
    }

    setSaving(true);
    try {
      const nextLogoUrl = pendingDark
        ? await uploadLogo(pendingDark, 'dark')
        : logoUrl;
      const nextLightUrl = pendingLight
        ? await uploadLogo(pendingLight, 'light')
        : logoLightUrl;

      // RLS (migration 040) rejects this write unless the caller's
      // profile has is_super_admin = true — this page is UI-level
      // gating, that policy is the real backstop. Without .select() a
      // write RLS filters out would look like a success.
      const { data: rows, error: updateError } = await supabase
        .from('platform_settings')
        .update({
          company_name: trimmedName,
          logo_url: nextLogoUrl,
          ...(lightSupported ? { logo_light_url: nextLightUrl } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', true)
        .select('id');
      if (updateError) throw new Error(updateError.message);
      if (!rows?.length) throw new Error(t('saveFailed'));

      setLogoUrl(nextLogoUrl);
      setLogoLightUrl(nextLightUrl);
      setSavedLightUrl(nextLightUrl);
      setSavedName(trimmedName);
      setPendingDark(null);
      setPendingLight(null);
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !loading &&
    (companyName.trim() !== savedName.trim() ||
      pendingDark !== null ||
      pendingLight !== null ||
      logoLightUrl !== savedLightUrl);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <LogoSlot
                label={t('logoDark')}
                hint={t('logoDarkHint')}
                surface="dark"
                url={logoUrl}
                pending={pendingDark}
                onPick={setPendingDark}
                disabled={saving}
              />
              <LogoSlot
                label={t('logoLight')}
                hint={lightSupported ? t('logoLightHint') : t('logoLightMigration')}
                surface="light"
                url={logoLightUrl ?? logoUrl}
                pending={pendingLight}
                onPick={setPendingLight}
                onRemove={
                  logoLightUrl || pendingLight
                    ? () => {
                        setPendingLight(null);
                        setLogoLightUrl(null);
                      }
                    : undefined
                }
                disabled={saving || !lightSupported}
              />
              <p className="text-xs text-muted-foreground sm:col-span-2">
                {t('logoHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-name" className="text-foreground">
                {t('companyName')}
              </Label>
              <Input
                id="company-name"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder={DEFAULT_BRANDING.companyName}
                maxLength={80}
                disabled={saving}
                required
              />
              <p className="text-xs text-muted-foreground">
                {t('companyNameHint')}
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving || !dirty}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveChanges')
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * One logo upload, previewed on the surface it will sit on so a white
 * or a dark wordmark can be checked against its real background.
 */
function LogoSlot({
  label,
  hint,
  surface,
  url,
  pending,
  onPick,
  onRemove,
  disabled,
}: {
  label: string;
  hint: string;
  surface: 'dark' | 'light';
  url: string;
  pending: File | null;
  onPick: (file: File | null) => void;
  onRemove?: () => void;
  disabled: boolean;
}) {
  const t = useTranslations('SuperAdmin.branding');
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrl = useMemo(
    () => (pending ? URL.createObjectURL(pending) : null),
    [pending],
  );

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ALLOWED_MIME.has(file.type)) {
      toast.error(t('unsupportedImage'));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(t('imageTooLarge'));
      return;
    }
    onPick(file);
  };

  return (
    <div className="space-y-2">
      <Label className="text-foreground">{label}</Label>
      <div
        className={cn(
          'flex h-28 items-center justify-center rounded-xl border p-3',
          surface === 'dark'
            ? 'border-slate-700 bg-slate-900'
            : 'border-slate-200 bg-white',
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Supabase Storage URL or local blob preview */}
        <img
          src={previewUrl ?? url}
          alt={label}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={onChange}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
        >
          <Upload className="size-4" />
          {t('changeLogo')}
        </Button>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={disabled}
          >
            <Trash2 className="size-4" />
            {t('removeLogo')}
          </Button>
        )}
      </div>
    </div>
  );
}
