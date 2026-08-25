'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ShieldCheck,
  Palette,
  Building2,
  Bot,
  Loader2,
  UsersRound,
  ToggleLeft,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiConfig } from '@/components/settings/ai-config';
import { BrandingPanel } from '@/components/super-admin/branding-panel';
import { AccountNamePanel } from '@/components/super-admin/account-name-panel';
import { UsersPanel } from '@/components/super-admin/users-panel';
import { ModulesPanel } from '@/components/super-admin/modules-panel';

type TabId = 'branding' | 'account' | 'agent' | 'users' | 'modules';

function isTabId(value: string | null): value is TabId {
  return (
    value === 'branding' ||
    value === 'account' ||
    value === 'agent' ||
    value === 'users' ||
    value === 'modules'
  );
}

// `useSearchParams` needs a Suspense boundary to avoid opting the page
// out of static prerendering (same reasoning as the login/settings
// pages — see their headers).
export default function SuperAdminPage() {
  return (
    <Suspense fallback={null}>
      <SuperAdminPageInner />
    </Suspense>
  );
}

// Client-side gate only — the real backstop is RLS (migration 040):
// every write this page can trigger (platform_settings, the branding
// storage bucket) is rejected server-side unless the caller's profile
// has is_super_admin = true. A non-super-admin who guesses this URL
// sees a spinner and gets bounced to /dashboard; they never see a
// flash of the panels themselves.
function SuperAdminPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isSuperAdmin, profileLoading } = useAuth();
  const t = useTranslations('SuperAdmin');

  const tab: TabId = isTabId(searchParams.get('tab'))
    ? (searchParams.get('tab') as TabId)
    : 'branding';

  const go = (next: TabId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/super-admin?${params.toString()}`, { scroll: false });
  };

  useEffect(() => {
    if (!profileLoading && !isSuperAdmin) {
      router.replace('/dashboard');
    }
  }, [profileLoading, isSuperAdmin, router]);

  if (profileLoading || !isSuperAdmin) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('pageTitle')}
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('pageDesc')}</p>

      <Tabs value={tab} onValueChange={(v) => go(v as TabId)} className="mt-6">
        <TabsList>
          <TabsTrigger value="branding">
            <Palette className="mr-1.5 h-4 w-4" /> {t('tabBranding')}
          </TabsTrigger>
          <TabsTrigger value="account">
            <Building2 className="mr-1.5 h-4 w-4" /> {t('tabAccount')}
          </TabsTrigger>
          <TabsTrigger value="agent">
            <Bot className="mr-1.5 h-4 w-4" /> {t('tabAgent')}
          </TabsTrigger>
          <TabsTrigger value="users">
            <UsersRound className="mr-1.5 h-4 w-4" /> {t('tabUsers')}
          </TabsTrigger>
          <TabsTrigger value="modules">
            <ToggleLeft className="mr-1.5 h-4 w-4" /> {t('tabModules')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="branding" className="mt-4">
          <BrandingPanel />
        </TabsContent>
        <TabsContent value="account" className="mt-4">
          <AccountNamePanel />
        </TabsContent>
        <TabsContent value="agent" className="mt-4">
          <AiConfig />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersPanel />
        </TabsContent>
        <TabsContent value="modules" className="mt-4">
          <ModulesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
