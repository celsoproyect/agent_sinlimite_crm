"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import {
  DollarSign,
  TrendingUp,
  Target,
  BarChart3,
  Trophy,
  XCircle,
  Info,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";
import { stageKind } from "@/lib/deals/reasons";
import { businessDate, businessToday } from "@/lib/business-timezone";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

/**
 * Weighted pipeline value: value × per-stage probability. Only open
 * stages count (won/lost columns hold no open deals): the first ≈ 10%,
 * the last ≈ 90%, interpolated in between.
 */
function computeStageProbability(
  stage: PipelineStage,
  openStages: PipelineStage[],
): number {
  const n = openStages.length;
  const index = openStages.findIndex((s) => s.id === stage.id);
  if (index < 0) return 0;
  if (n <= 1) return 0.5;
  return 0.1 + (index / (n - 1)) * (0.9 - 0.1);
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const t = useTranslations("Pipelines.analytics");
  const { defaultCurrency } = useAuth();
  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const stats = useMemo(() => {
    // Closed deals leave the board, so the money figures cover open
    // deals only; won/lost show up in the monthly counts.
    const openDeals = deals.filter((d) => (d.status ?? "open") === "open");

    const totalCount = openDeals.length;
    const totalValue = openDeals.reduce((sum, d) => sum + Number(d.value || 0), 0);
    const avgValue = totalCount > 0 ? totalValue / totalCount : 0;

    const openStages = sortedStages.filter((s) => stageKind(s) === "open");
    const stageById = new Map(openStages.map((s) => [s.id, s]));
    const weightedValue = openDeals.reduce((sum, d) => {
      const stage = stageById.get(d.stage_id);
      if (!stage) return sum;
      return sum + Number(d.value || 0) * computeStageProbability(stage, openStages);
    }, 0);

    // Business-local month, by the close date.
    const monthStart = `${businessToday().slice(0, 7)}-01`;
    const thisMonth = (d: Deal) => {
      const ts = d.closed_at || d.updated_at || d.created_at;
      return ts ? businessDate(ts) >= monthStart : false;
    };
    const wonThisMonth = deals.filter((d) => d.status === "won" && thisMonth(d)).length;
    const lostThisMonth = deals.filter((d) => d.status === "lost" && thisMonth(d)).length;

    return {
      totalCount,
      totalValue,
      avgValue,
      weightedValue,
      wonThisMonth,
      lostThisMonth,
    };
  }, [deals, sortedStages]);

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
          label={t("totalDeals")}
          value={String(stats.totalCount)}
          tooltip={t("totalDealsTooltip")}
          t={t}
        />
        <Metric
          icon={<DollarSign className="h-4 w-4 text-primary" />}
          label={t("pipelineValue")}
          value={formatCurrency(stats.totalValue, defaultCurrency)}
          tooltip={t("pipelineValueTooltip")}
          t={t}
        />
        <Metric
          icon={<Target className="h-4 w-4 text-blue-400" />}
          label={t("avgDealSize")}
          value={formatCurrency(stats.avgValue, defaultCurrency)}
          tooltip={t("avgDealSizeTooltip")}
          t={t}
        />
        <Metric
          icon={<TrendingUp className="h-4 w-4 text-purple-400" />}
          label={t("weightedValue")}
          value={formatCurrency(stats.weightedValue, defaultCurrency)}
          tooltip={t("weightedValueTooltip")}
          t={t}
        />
        <Metric
          icon={<Trophy className="h-4 w-4 text-primary" />}
          label={t("wonThisMonth")}
          value={String(stats.wonThisMonth)}
          tooltip={t("wonThisMonthTooltip")}
          t={t}
        />
        <Metric
          icon={<XCircle className="h-4 w-4 text-red-400" />}
          label={t("lostThisMonth")}
          value={String(stats.lostThisMonth)}
          tooltip={t("lostThisMonthTooltip")}
          t={t}
        />
      </div>
    </TooltipProvider>
  );
}

function Metric({
  icon,
  label,
  value,
  tooltip,
  t,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tooltip: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <div className="flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("howCalculated", { label })}
                className="ml-auto text-muted-foreground hover:text-foreground focus:outline-none"
              />
            }
          >
            <Info className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="mt-1 text-base font-semibold text-foreground">{value}</p>
    </div>
  );
}
