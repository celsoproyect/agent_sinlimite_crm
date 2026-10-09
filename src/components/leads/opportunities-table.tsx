"use client";

// ============================================================
// Leads → Oportunidades: every deal of the account across all
// pipelines (open, won and lost), with summary counts, filters and CSV
// export. Dates are business-local days (America/Santo_Domingo).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Loader2, Search, Target, Trophy, XCircle } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { businessToday } from "@/lib/business-timezone";
import type { DayRange } from "@/lib/bookings/ranges";
import { LOST_REASONS, isLostReason } from "@/lib/deals/reasons";
import {
  RANGE_KINDS,
  closedDay,
  createdDay,
  filterLeads,
  leadsToCsv,
  rangeFor,
  summarizeLeads,
  type DateField,
  type LeadDeal,
  type LeadSource,
  type LeadStatus,
  type LeadsPayload,
  type RangeKind,
  type StatusFilter,
} from "@/lib/leads/opportunities";
import { cn } from "@/lib/utils";
import { DealForm } from "@/components/pipelines/deal-form";
import { ContactDetailView } from "@/components/contacts/contact-detail-view";

const PAGE_SIZE = 100;
const STATUSES: StatusFilter[] = ["all", "open", "won", "lost"];

export const selectClass =
  "h-10 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground sm:h-8";

export function chipClass(active: boolean) {
  return cn(
    "rounded-full border px-3 py-2 text-xs font-medium transition-colors sm:py-1",
    active
      ? "border-primary bg-primary text-primary-foreground"
      : "border-border bg-background text-muted-foreground hover:text-foreground",
  );
}

export function dayLabel(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const STATUS_BADGE: Record<LeadStatus, string> = {
  open: "bg-primary/10 text-primary",
  won: "bg-emerald-500/10 text-emerald-600",
  lost: "bg-rose-500/10 text-rose-600",
};

export function OpportunitiesTable() {
  const t = useTranslations("Leads.opportunities");
  const tr = useTranslations("Leads.range");
  const tc = useTranslations("Pipelines.closed");
  const { defaultCurrency } = useAuth();
  const today = businessToday();

  const [data, setData] = useState<LeadsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [status, setStatus] = useState<StatusFilter>("all");
  const [dateField, setDateField] = useState<DateField>("created");
  const [rangeKind, setRangeKind] = useState<RangeKind>("all");
  const [custom, setCustom] = useState<DayRange>({ from: `${today.slice(0, 7)}-01`, to: today });
  const [pipelineId, setPipelineId] = useState("all");
  const [reason, setReason] = useState("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);

  const [editing, setEditing] = useState<LeadDeal | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch("/api/leads/deals");
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as LeadsPayload);
    } catch (err) {
      console.error("[leads] deals load failed:", err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const range = useMemo(() => rangeFor(rangeKind, custom, today), [rangeKind, custom, today]);

  const visible = useMemo(
    () =>
      filterLeads(data?.deals ?? [], { status, dateField, range, pipelineId, reason, query }),
    [data, status, dateField, range, pipelineId, reason, query],
  );
  // The cards describe every status of the filtered period, so the
  // close rate stays meaningful while the list shows only one status.
  const summary = useMemo(
    () =>
      summarizeLeads(
        filterLeads(data?.deals ?? [], { status: "all", dateField, range, pipelineId, reason, query }),
        defaultCurrency,
      ),
    [data, dateField, range, pipelineId, reason, query, defaultCurrency],
  );

  const pipelineName = useMemo(() => {
    const map = new Map((data?.pipelines ?? []).map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? "—";
  }, [data]);
  const stageName = useMemo(() => {
    const map = new Map((data?.stages ?? []).map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) ?? "—";
  }, [data]);

  const reasonLabel = (r: string | null | undefined) =>
    isLostReason(r) ? tc(`reasons.${r}`) : tc("reasons.other");
  const statusLabel = (s: LeadStatus) => t(`status.${s}`);
  const sourceLabel = (s: LeadSource | null) => (s ? t(`source.${s}`) : "—");

  const wonValueText = Object.entries(summary.wonValue).length
    ? Object.entries(summary.wonValue)
        .map(([cur, v]) => formatCurrency(v, cur))
        .join(" · ")
    : formatCurrency(0, defaultCurrency);

  function exportCsv() {
    const csv = leadsToCsv(visible, {
      headers: [
        t("csv.contact"),
        t("csv.phone"),
        t("csv.email"),
        t("csv.title"),
        t("csv.pipeline"),
        t("csv.stage"),
        t("csv.status"),
        t("csv.value"),
        t("csv.currency"),
        t("csv.lostReason"),
        t("csv.created"),
        t("csv.closed"),
        t("csv.source"),
      ],
      pipelineName,
      stageName,
      statusLabel,
      reasonLabel,
      sourceLabel,
    });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Any filter change starts the list from the top again.
  function withReset<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setShown(PAGE_SIZE);
    };
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }
  if (failed || !data) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {t("loadFailed")}
      </div>
    );
  }

  const editingStages = editing ? data.stages.filter((s) => s.pipeline_id === editing.pipeline_id) : [];
  const rows = visible.slice(0, shown);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <SummaryCard icon={<Target className="size-4 text-primary" />} label={t("summaryTotal")} value={String(summary.total)} sub={t("summaryOpen", { count: summary.open })} />
        <SummaryCard icon={<Trophy className="size-4 text-emerald-500" />} label={t("summaryWon")} value={String(summary.won)} />
        <SummaryCard icon={<XCircle className="size-4 text-rose-500" />} label={t("summaryLost")} value={String(summary.lost)} />
        <SummaryCard
          label={t("summaryWinRate")}
          value={summary.winRate === null ? "–" : `${summary.winRate}%`}
          sub={t("summaryWinRateSub")}
        />
        <SummaryCard className="col-span-2 lg:col-span-1" label={t("summaryWonValue")} value={wonValueText} />
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <button key={s} type="button" onClick={() => withReset(setStatus)(s)} className={chipClass(status === s)}>
              {t(`statusFilter.${s}`)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {RANGE_KINDS.map((r) => (
            <button key={r} type="button" onClick={() => withReset(setRangeKind)(r)} className={chipClass(rangeKind === r)}>
              {tr(r)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              if (range) setCustom(range);
              withReset(setRangeKind)("custom");
            }}
            className={chipClass(rangeKind === "custom")}
          >
            {tr("custom")}
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("dateField")}
            <select
              value={dateField}
              onChange={(e) => withReset(setDateField)(e.target.value as DateField)}
              className={selectClass}
            >
              <option value="created">{t("dateCreated")}</option>
              <option value="closed">{t("dateClosed")}</option>
            </select>
          </label>
          {rangeKind === "custom" && (
            <>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {tr("from")}
                <input
                  type="date"
                  value={custom.from}
                  onChange={(e) => e.target.value && withReset(setCustom)({ ...custom, from: e.target.value })}
                  className={selectClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {tr("to")}
                <input
                  type="date"
                  value={custom.to}
                  min={custom.from}
                  onChange={(e) => e.target.value && withReset(setCustom)({ ...custom, to: e.target.value })}
                  className={selectClass}
                />
              </label>
            </>
          )}
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            {t("pipeline")}
            <select value={pipelineId} onChange={(e) => withReset(setPipelineId)(e.target.value)} className={selectClass}>
              <option value="all">{t("pipelineAll")}</option>
              {data.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            {t("reason")}
            <select value={reason} onChange={(e) => withReset(setReason)(e.target.value)} className={selectClass}>
              <option value="all">{t("reasonAll")}</option>
              {LOST_REASONS.map((r) => (
                <option key={r} value={r}>
                  {tc(`reasons.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="relative min-w-0 flex-1 basis-48">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => withReset(setQuery)(e.target.value)}
              placeholder={t("search")}
              className="h-10 w-full rounded-md border border-border bg-background pr-2 pl-8 text-sm text-foreground sm:h-8"
            />
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={visible.length === 0}
            className="inline-flex h-10 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-foreground hover:bg-muted disabled:opacity-50 sm:h-8"
          >
            <Download className="size-4" />
            {t("export")}
          </button>
        </div>

        {visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {data.deals.length === 0 ? t("emptyAll") : t("empty")}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{t("count", { count: visible.length })}</p>

            {/* Phones: cards. */}
            <ul className="space-y-2 md:hidden">
              {rows.map((d) => (
                <li key={d.id} className="rounded-lg border border-border bg-background p-3">
                  <button type="button" onClick={() => setEditing(d)} className="block w-full text-left">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-sm font-medium text-foreground">{d.title}</span>
                      <StatusBadge status={d.lead_status} label={statusLabel(d.lead_status)} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {pipelineName(d.pipeline_id)} · {stageName(d.stage_id)}
                    </p>
                    <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">
                      {formatCurrency(Number(d.value || 0), d.currency || defaultCurrency)}
                    </p>
                    {d.lead_status === "lost" && (
                      <p className="mt-1 text-xs text-foreground">{reasonLabel(d.lost_reason)}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("createdOn", { date: dayLabel(createdDay(d)) })}
                      {closedDay(d) && ` · ${t("closedOn", { date: dayLabel(closedDay(d)!) })}`}
                      {d.source && ` · ${sourceLabel(d.source)}`}
                    </p>
                  </button>
                  {d.contact_id && (
                    <button
                      type="button"
                      onClick={() => setContactId(d.contact_id)}
                      className="mt-2 text-xs font-medium text-primary hover:underline"
                    >
                      {d.contact?.name || d.contact?.email || d.contact?.phone || t("noContact")}
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {/* Tablets and up: a table that scrolls inside its own box. */}
            <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t("col.contact")}</th>
                    <th className="px-3 py-2 font-medium">{t("col.title")}</th>
                    <th className="px-3 py-2 font-medium">{t("col.stage")}</th>
                    <th className="px-3 py-2 font-medium">{t("col.status")}</th>
                    <th className="px-3 py-2 text-right font-medium">{t("col.value")}</th>
                    <th className="px-3 py-2 font-medium">{t("col.lostReason")}</th>
                    <th className="px-3 py-2 font-medium">{t("col.created")}</th>
                    <th className="px-3 py-2 font-medium">{t("col.closed")}</th>
                    <th className="px-3 py-2 font-medium">{t("col.source")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((d) => {
                    const closed = closedDay(d);
                    return (
                      <tr
                        key={d.id}
                        onClick={() => setEditing(d)}
                        className="cursor-pointer align-top hover:bg-muted/50"
                      >
                        <td className="max-w-48 px-3 py-2">
                          {d.contact_id ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setContactId(d.contact_id);
                              }}
                              className="block max-w-full truncate text-left font-medium text-primary hover:underline"
                            >
                              {d.contact?.name || d.contact?.email || d.contact?.phone || t("noContact")}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">{t("noContact")}</span>
                          )}
                          {d.contact?.phone && d.contact?.name && (
                            <span className="block truncate text-xs text-muted-foreground">{d.contact.phone}</span>
                          )}
                        </td>
                        <td className="max-w-56 px-3 py-2 text-foreground">
                          <span className="line-clamp-2">{d.title}</span>
                        </td>
                        <td className="max-w-48 px-3 py-2 text-xs">
                          <span className="block truncate text-foreground">{pipelineName(d.pipeline_id)}</span>
                          <span className="block truncate text-muted-foreground">{stageName(d.stage_id)}</span>
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={d.lead_status} label={statusLabel(d.lead_status)} />
                        </td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">
                          {formatCurrency(Number(d.value || 0), d.currency || defaultCurrency)}
                        </td>
                        <td className="max-w-40 px-3 py-2 text-xs text-foreground">
                          {d.lead_status === "lost" ? reasonLabel(d.lost_reason) : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                          {dayLabel(createdDay(d))}
                        </td>
                        <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                          {closed ? dayLabel(closed) : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{sourceLabel(d.source)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {visible.length > shown && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setShown((n) => n + PAGE_SIZE)}
                  className="rounded-md border border-border bg-background px-4 py-2 text-sm text-foreground hover:bg-muted"
                >
                  {t("showMore", { count: visible.length - shown })}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {editing && (
        <DealForm
          open={!!editing}
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          deal={editing}
          pipelineId={editing.pipeline_id}
          stages={editingStages}
          onSaved={() => {
            void load();
          }}
        />
      )}

      <ContactDetailView
        open={!!contactId}
        onOpenChange={(o) => {
          if (!o) setContactId(null);
        }}
        contactId={contactId}
        onUpdated={() => {
          void load();
        }}
      />
    </div>
  );
}

function StatusBadge({ status, label }: { status: LeadStatus; label: string }) {
  return (
    <span className={cn("inline-block shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", STATUS_BADGE[status])}>
      {label}
    </span>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  sub,
  className,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-xl border border-border bg-card p-4", className)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        <span className="min-w-0 break-words">{label}</span>
      </p>
      <p className="mt-1 break-words text-xl font-bold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
