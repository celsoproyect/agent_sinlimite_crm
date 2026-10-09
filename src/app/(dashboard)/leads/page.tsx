"use client";

// ============================================================
// Leads — every opportunity across pipelines (open, won, lost) and the
// raw submissions of the web lead form (migration 070). Page module
// `leads`. Dates are business-local days (America/Santo_Domingo).
// ============================================================

import { useTranslations } from "next-intl";
import { FileText, Loader2, Target } from "lucide-react";
import { useModuleGate } from "@/hooks/use-module-gate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OpportunitiesTable } from "@/components/leads/opportunities-table";
import { FormSubmissions } from "@/components/leads/form-submissions";

export default function LeadsPage() {
  const t = useTranslations("Leads");
  const { ready, loading } = useModuleGate("leads");

  if (loading || !ready) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <Target className="h-5 w-5 shrink-0 text-primary" />
          <h1 className="min-w-0 text-lg font-semibold text-foreground">{t("title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <Tabs defaultValue="opportunities">
        <TabsList>
          <TabsTrigger value="opportunities">
            <Target className="mr-1.5 h-4 w-4" /> {t("tabOpportunities")}
          </TabsTrigger>
          <TabsTrigger value="forms">
            <FileText className="mr-1.5 h-4 w-4" /> {t("tabForms")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="opportunities" className="mt-4 min-w-0">
          <OpportunitiesTable />
        </TabsContent>
        <TabsContent value="forms" className="mt-4 min-w-0">
          <FormSubmissions />
        </TabsContent>
      </Tabs>
    </div>
  );
}
