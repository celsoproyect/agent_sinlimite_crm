'use client';

import { useRouter } from 'next/navigation';
import { Bot, Sparkles, BarChart3 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

// Provider/API-key setup (formerly a "Setup" tab here) moved to
// /super-admin — the config a reseller sets up once per client
// install and doesn't want the client's own owner/admin touching.
// Regular account roles only ever see Playground (+ Usage for
// admin+) here.
export default function AgentsPage() {
  const router = useRouter();
  const { accountRole, isSuperAdmin } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          AI Agents
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Your bring-your-own-key AI agent — set it up, then test it in the
        playground before it replies to customers in the inbox.
      </p>

      <Tabs defaultValue="playground" className="mt-6">
        <TabsList>
          <TabsTrigger value="playground">
            <Sparkles className="mr-1.5 h-4 w-4" /> Playground
          </TabsTrigger>
          {canViewUsage && (
            <TabsTrigger value="usage">
              <BarChart3 className="mr-1.5 h-4 w-4" /> Usage
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="playground" className="mt-4">
          <AiPlayground
            onGoToSetup={
              isSuperAdmin
                ? () => router.push('/super-admin?tab=agent')
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
