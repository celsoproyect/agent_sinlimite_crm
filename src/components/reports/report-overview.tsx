"use client";

import { useTranslations } from "next-intl";
import {
  Bot,
  CalendarCheck,
  Clock,
  DollarSign,
  MessageSquare,
  Timer,
  UserPlus,
  Users,
} from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { ReportOverview as Overview, SalesBucket } from "@/lib/reports/overview";
import { durationParts, formatMoney } from "@/lib/reports/format";

const AI_COLOR = "#7c3aed";
const HUMAN_COLOR = "#f59e0b";
const CUSTOMER_COLOR = "#3b82f6";

export function ReportOverview({ overview, loading }: { overview: Overview | null; loading: boolean }) {
  const t = useTranslations("Reports");

  if (loading || !overview) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[132px] w-full" />
          ))}
        </div>
        <Skeleton className="h-[260px] w-full" />
      </div>
    );
  }

  const o = overview;
  const handled = o.conversations.aiOnly + o.conversations.withHuman;
  const duration = (s: number | null) => {
    if (s == null) return "—";
    const { value, unit } = durationParts(s);
    return t(`units.${unit}`, { n: value });
  };
  const channelLabel = (ch: string) =>
    ch === "whatsapp" || ch === "web" ? t(`channels.${ch}`) : t("channels.other");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={t("cards.conversations")}
          value={String(o.conversations.total)}
          icon={MessageSquare}
          subtitle={t("cards.conversationsHint", {
            ai: o.conversations.aiOnly,
            human: o.conversations.withHuman,
            pending: o.conversations.unanswered,
          })}
        />
        <MetricCard
          title={t("cards.aiRate")}
          value={o.conversations.aiRate == null ? "—" : `${o.conversations.aiRate}%`}
          icon={Bot}
          subtitle={t("cards.aiRateHint", { ai: o.conversations.aiOnly, total: handled })}
        />
        <MetricCard
          title={t("cards.aiMessages")}
          value={String(o.messages.ai)}
          icon={Bot}
          subtitle={t("cards.aiMessagesHint", {
            human: o.messages.human,
            customer: o.messages.customer,
          })}
        />
        <MetricCard
          title={t("cards.aiRevenue")}
          value={formatMoney(o.sales.aiAssisted.totals)}
          icon={DollarSign}
          subtitle={t("cards.aiRevenueHint", { count: o.sales.aiAssisted.count })}
        />
        <MetricCard
          title={t("cards.responseAi")}
          value={duration(o.responseTime.ai.medianSeconds)}
          icon={Timer}
          subtitle={t("cards.responseHint", {
            avg: duration(o.responseTime.ai.avgSeconds),
            count: o.responseTime.ai.count,
          })}
        />
        <MetricCard
          title={t("cards.responseHuman")}
          value={duration(o.responseTime.human.medianSeconds)}
          icon={Clock}
          subtitle={t("cards.responseHint", {
            avg: duration(o.responseTime.human.avgSeconds),
            count: o.responseTime.human.count,
          })}
        />
        <MetricCard
          title={t("cards.newContacts")}
          value={String(o.newContacts.total)}
          icon={UserPlus}
          subtitle={
            Object.entries(o.newContacts.byChannel)
              .map(([ch, n]) => `${channelLabel(ch)}: ${n}`)
              .join(" · ") || t("cards.none")
          }
        />
        <MetricCard
          title={t("cards.bookings")}
          value={String(o.bookings.total)}
          icon={CalendarCheck}
          subtitle={t("cards.bookingsHint", { ai: o.bookings.byAi })}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        <ActivityChart series={o.series} />
        <SalesCard
          won={o.sales.won}
          aiAssisted={o.sales.aiAssisted}
          byChannel={o.sales.byChannel}
          channelLabel={channelLabel}
          dealsUnavailable={o.unavailable.includes("deals")}
        />
      </div>
    </div>
  );
}

function ActivityChart({ series }: { series: Overview["series"] }) {
  const t = useTranslations("Reports");
  const max = Math.max(1, ...series.map((p) => Math.max(p.ai + p.human, p.customer)));
  const empty = series.every((p) => p.ai + p.human + p.customer === 0);
  const stride = Math.max(1, Math.ceil(series.length / 8));

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t("activity.title")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("activity.description")}</p>
      </header>
      <div className="flex-1 p-5">
        {empty ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t("activity.empty")}</p>
        ) : (
          <div className="flex h-[200px] items-end gap-1">
            {series.map((p, i) => (
              <div key={p.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                <div
                  className="flex h-full w-full items-end justify-center gap-[2px]"
                  title={t("activity.tooltip", { date: p.date, ai: p.ai, human: p.human, customer: p.customer })}
                >
                  <div
                    className="w-1/2 max-w-3 rounded-t-sm"
                    style={{ height: `${(p.customer / max) * 100}%`, background: CUSTOMER_COLOR }}
                  />
                  <div className="flex w-1/2 max-w-3 flex-col justify-end" style={{ height: "100%" }}>
                    <div
                      className="rounded-t-sm"
                      style={{ height: `${(p.human / max) * 100}%`, background: HUMAN_COLOR }}
                    />
                    <div style={{ height: `${(p.ai / max) * 100}%`, background: AI_COLOR }} />
                  </div>
                </div>
                <span className="h-3 text-[10px] leading-3 text-muted-foreground">
                  {i % stride === 0 ? `${p.date.slice(8, 10)}/${p.date.slice(5, 7)}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-4 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <Legend color={CUSTOMER_COLOR} label={t("activity.customer")} />
        <Legend color={AI_COLOR} label={t("activity.ai")} />
        <Legend color={HUMAN_COLOR} label={t("activity.human")} />
      </footer>
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function SalesCard({
  won,
  aiAssisted,
  byChannel,
  channelLabel,
  dealsUnavailable,
}: {
  won: SalesBucket;
  aiAssisted: SalesBucket;
  byChannel: Record<string, SalesBucket>;
  channelLabel: (ch: string) => string;
  dealsUnavailable: boolean;
}) {
  const t = useTranslations("Reports");
  const channels = Object.entries(byChannel).sort((a, b) => b[1].count - a[1].count);

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Users className="h-4 w-4 text-primary" />
          {t("sales.title")}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("sales.description")}</p>
      </header>
      <div className="space-y-4 p-5 text-sm">
        {dealsUnavailable ? (
          <p className="text-xs text-muted-foreground">{t("sales.unavailable")}</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{t("sales.won", { count: won.count })}</span>
              <span className="text-right font-semibold tabular-nums text-foreground">{formatMoney(won.totals)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{t("sales.aiAssisted", { count: aiAssisted.count })}</span>
              <span className="text-right font-semibold tabular-nums text-primary">{formatMoney(aiAssisted.totals)}</span>
            </div>
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">{t("sales.byChannel")}</p>
              {channels.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("sales.none")}</p>
              ) : (
                channels.map(([ch, b]) => (
                  <div key={ch} className="flex items-baseline justify-between gap-3">
                    <span className="text-foreground">
                      {channelLabel(ch)} <span className="text-xs text-muted-foreground">({b.count})</span>
                    </span>
                    <span className="text-right tabular-nums text-foreground">{formatMoney(b.totals)}</span>
                  </div>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("sales.aiNote")}</p>
          </>
        )}
      </div>
    </section>
  );
}
