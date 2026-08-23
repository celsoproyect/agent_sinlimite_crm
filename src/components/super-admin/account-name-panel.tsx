'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

export function AccountNamePanel() {
  const t = useTranslations('SuperAdmin.account');
  const { account, refreshProfile } = useAuth();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) setName(account.name);
  }, [account]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t('saveFailed'));
      await refreshProfile();
      toast.success(t('saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const dirty = !!account && name.trim() !== account.name;

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <CardContent className="space-y-2">
            <Label htmlFor="account-name" className="text-foreground">
              {t('accountName')}
            </Label>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              disabled={saving || !account}
              required
            />
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
