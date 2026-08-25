'use client';

import { Loader2, PlugZap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useModuleGate } from '@/hooks/use-module-gate';
import { WidgetSettings } from '@/components/channels/widget-settings';
import { LeadFormSettings } from '@/components/channels/lead-form-settings';
import { TelegramSettings } from '@/components/channels/telegram-settings';

export default function ChannelsPage() {
  const t = useTranslations('Channels.page');
  const { ready: moduleReady, loading: moduleGateLoading } = useModuleGate('channels');

  if (moduleGateLoading || !moduleReady) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <PlugZap className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>

      <div className="space-y-10 divide-y divide-border">
        <WidgetSettings />
        <div className="pt-8">
          <LeadFormSettings />
        </div>
        <div className="pt-8">
          <TelegramSettings />
        </div>
      </div>
    </div>
  );
}
