'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Upload } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(true);
  const [companyName, setCompanyName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [logoUrl, setLogoUrl] = useState<string>(DEFAULT_BRANDING.logoUrl);
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('platform_settings')
      .select('company_name, logo_url')
      .eq('id', true)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data) {
          const name = data.company_name || DEFAULT_BRANDING.companyName;
          setCompanyName(name);
          setSavedName(name);
          setLogoUrl(data.logo_url || DEFAULT_BRANDING.logoUrl);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const currentLogo = previewUrl ?? logoUrl;

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
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

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingLogo(file);
    setPreviewUrl(URL.createObjectURL(file));
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
      let nextLogoUrl = logoUrl;

      if (pendingLogo) {
        const ext = pendingLogo.name.split('.').pop()?.toLowerCase() || 'png';
        const path = `logo-${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from('branding')
          .upload(path, pendingLogo, {
            cacheControl: '3600',
            upsert: true,
            contentType: pendingLogo.type,
          });
        if (uploadError) throw new Error(uploadError.message);
        const {
          data: { publicUrl },
        } = supabase.storage.from('branding').getPublicUrl(path);
        nextLogoUrl = publicUrl;
      }

      // RLS (migration 040) rejects this write unless the caller's
      // profile has is_super_admin = true — this page is UI-level
      // gating, that policy is the real backstop.
      const { error: updateError } = await supabase
        .from('platform_settings')
        .update({
          company_name: trimmedName,
          logo_url: nextLogoUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', true);
      if (updateError) throw new Error(updateError.message);

      setLogoUrl(nextLogoUrl);
      setSavedName(trimmedName);
      setPendingLogo(null);
      setPreviewUrl(null);
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !loading && (companyName.trim() !== savedName.trim() || pendingLogo !== null);

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
            <div className="flex flex-wrap items-center gap-5">
              <img
                src={currentLogo}
                alt={companyName || 'Logo'}
                width={64}
                height={64}
                className="h-16 w-16 rounded-xl border border-border object-contain"
              />
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={onPickFile}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={saving}
                >
                  <Upload className="size-4" />
                  {t('changeLogo')}
                </Button>
                <p className="w-full text-xs text-muted-foreground">
                  {t('logoHint')}
                </p>
              </div>
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
