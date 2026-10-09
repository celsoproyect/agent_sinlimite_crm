'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bot, Loader2, Sparkles, BarChart3 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { useModuleGate } from '@/hooks/use-module-gate';

// The agent itself is set up in Configuración → Agente de IA by the
// account's owner/admin; the provider key belongs to the platform
// (Super admin → IA de la plataforma, migration 072). This page is the
// Playground (+ Usage for admin+).
export default function AgentsPage() {
  const router = useRouter();
  const t = useTranslations('Agents.page');
  const { accountRole } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const { ready: moduleReady, loading: moduleGateLoading } = useModuleGate("agents");

  if (moduleGateLoading || !moduleReady) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('title')}
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('description')}
      </p>

      <Tabs defaultValue="playground" className="mt-6">
        <TabsList>
          <TabsTrigger value="playground">
            <Sparkles className="mr-1.5 h-4 w-4" /> {t('playgroundTab')}
          </TabsTrigger>
          {canViewUsage && (
            <TabsTrigger value="usage">
              <BarChart3 className="mr-1.5 h-4 w-4" /> {t('usageTab')}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="playground" className="mt-4">
          <AiPlayground
            onGoToSetup={
              canViewUsage
                ? () => router.push('/settings?tab=ai-agent')
                : undefined
            }
          />
        </TabsContent>

        {canViewUsage && (
          <TabsContent value="usage" className="mt-4">
            <AiUsageCard />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
