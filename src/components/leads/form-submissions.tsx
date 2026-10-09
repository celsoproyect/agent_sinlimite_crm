"use client";

// ============================================================
// Leads → Formularios: every web form submission (migration 070),
// newest first. Opening one shows every raw field and marks it read.
// Until the owner runs migration 070, a notice asks for it.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Database, ExternalLink, Inbox, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import type { Deal, PipelineStage } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { businessDate, businessTime, businessToday } from "@/lib/business-timezone";
import type { DayRange } from "@/lib/bookings/ranges";
import { RANGE_KINDS, rangeFor, type RangeKind } from "@/lib/leads/opportunities";
import { fieldValueText, type LeadFormSubmission } from "@/lib/leads/submissions";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DealForm } from "@/components/pipelines/deal-form";
import { ContactDetailView } from "@/components/contacts/contact-detail-view";
import { chipClass, dayLabel, selectClass } from "./opportunities-table";

const PAGE_SIZE = 100;

/** Fields already shown in the header of the detail sheet. */
const HEADER_FIELDS = new Set(["full_name", "name", "email", "phone"]);
/** Fields the standard form sends, shown with a translated label. */
const KNOWN_FIELDS = new Set(["company", "service", "employee_count", "message", "source_url", "page_url"]);

export function FormSubmissions() {
  const t = useTranslations("Leads.forms");
  const tr = useTranslations("Leads.range");
  const today = businessToday();

  const [submissions, setSubmissions] = useState<LeadFormSubmission[]>([]);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [rangeKind, setRangeKind] = useState<RangeKind>("all");
  const [custom, setCustom] = useState<DayRange>({ from: `${today.slice(0, 7)}-01`, to: today });
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);

  const [openId, setOpenId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [deal, setDeal] = useState<{ deal: Deal; stages: PipelineStage[] } | null>(null);
  const [dealLoading, setDealLoading] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch("/api/leads/submissions");
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { missing: boolean; submissions: LeadFormSubmission[] };
      setMissing(json.missing);
      setSubmissions(json.submissions);
    } catch (err) {
      console.error("[leads] submissions load failed:", err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const range = useMemo(() => rangeFor(rangeKind, custom, today), [rangeKind, custom, today]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return submissions.filter((s) => {
      if (unreadOnly && s.is_read) return false;
      if (range) {
        const day = businessDate(s.created_at);
        if (day < range.from || day > range.to) return false;
      }
      if (q) {
        const hay = [s.name, s.email, s.phone, s.message, ...Object.values(s.fields ?? {}).map(fieldValueText)]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [submissions, unreadOnly, range, query]);

  const unreadCount = submissions.filter((s) => !s.is_read).length;
  const open = submissions.find((s) => s.id === openId) ?? null;

  async function setRead(s: LeadFormSubmission, isRead: boolean) {
    setSubmissions((list) => list.map((x) => (x.id === s.id ? { ...x, is_read: isRead } : x)));
    try {
      const res = await fetch(`/api/leads/submissions/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_read: isRead }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch (err) {
      console.error("[leads] mark read failed:", err);
      setSubmissions((list) => list.map((x) => (x.id === s.id ? { ...x, is_read: s.is_read } : x)));
      toast.error(t("markFailed"));
    }
  }

  function openSubmission(s: LeadFormSubmission) {
    setOpenId(s.id);
    if (!s.is_read) void setRead(s, true);
  }

  async function openDeal(dealId: string) {
    setDealLoading(true);
    try {
      const supabase = createClient();
      const { data: row, error } = await supabase
        .from("deals")
        .select("*, contact:contacts(*)")
        .eq("id", dealId)
        .maybeSingle();
      if (error || !row) throw error ?? new Error("not found");
      const { data: stages } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", row.pipeline_id)
        .order("position");
      setOpenId(null);
      setDeal({ deal: row as Deal, stages: (stages ?? []) as PipelineStage[] });
    } catch (err) {
      console.error("[leads] deal load failed:", err);
      toast.error(t("dealMissing"));
    } finally {
      setDealLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }
  if (failed) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {t("loadFailed")}
      </div>
    );
  }
  if (missing) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
        <Database className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">{t("migrationTitle")}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("migrationBody", { file: "070_lead_form_submissions.sql" })}
        </p>
      </div>
    );
  }

  const rows = visible.slice(0, shown);
  const extraFields = open
    ? Object.entries(open.fields ?? {}).filter(([k, v]) => !HEADER_FIELDS.has(k) && fieldValueText(v) !== "")
    : [];

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap gap-1.5">
          {RANGE_KINDS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setRangeKind(r);
                setShown(PAGE_SIZE);
              }}
              className={chipClass(rangeKind === r)}
            >
              {tr(r)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              if (range) setCustom(range);
              setRangeKind("custom");
              setShown(PAGE_SIZE);
            }}
            className={chipClass(rangeKind === "custom")}
          >
            {tr("custom")}
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {rangeKind === "custom" && (
            <>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {tr("from")}
                <input
                  type="date"
                  value={custom.from}
                  onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
                  className={selectClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {tr("to")}
                <input
                  type="date"
                  value={custom.to}
                  min={custom.from}
                  onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
                  className={selectClass}
                />
              </label>
            </>
          )}
          <div className="relative min-w-0 flex-1 basis-48">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE_SIZE);
              }}
              placeholder={t("search")}
              className="h-10 w-full rounded-md border border-border bg-background pr-2 pl-8 text-sm text-foreground sm:h-8"
            />
          </div>
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            className={chipClass(unreadOnly)}
          >
            {t("unreadOnly", { count: unreadCount })}
          </button>
        </div>

        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Inbox className="size-6" />
            {submissions.length === 0 ? t("emptyAll") : t("empty")}
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{t("count", { count: visible.length })}</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {rows.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => openSubmission(s)}
                    className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/50"
                  >
                    <span
                      aria-label={s.is_read ? undefined : t("unread")}
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        s.is_read ? "bg-transparent" : "bg-primary",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span
                          className={cn(
                            "min-w-0 truncate text-sm text-foreground",
                            s.is_read ? "font-normal" : "font-semibold",
                          )}
                        >
                          {s.name || s.email || s.phone || t("noName")}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {dayLabel(businessDate(s.created_at))} {businessTime(s.created_at)}
                        </span>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[s.email, s.phone].filter(Boolean).join(" · ") || "—"}
                      </span>
                      {s.message && (
                        <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">{s.message}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
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

      <Sheet
        open={!!open}
        onOpenChange={(o) => {
          if (!o) setOpenId(null);
        }}
      >
        <SheetContent className="w-full sm:max-w-lg">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-8 break-words">{open.name || open.email || t("noName")}</SheetTitle>
                <SheetDescription>
                  {t("receivedAt", {
                    date: dayLabel(businessDate(open.created_at)),
                    time: businessTime(open.created_at),
                  })}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-5 px-4 pb-6">
                <dl className="grid gap-3 text-sm">
                  <Field label={t("email")} value={open.email} />
                  <Field label={t("phone")} value={open.phone} />
                  {extraFields.map(([k, v]) => (
                    <Field
                      key={k}
                      label={KNOWN_FIELDS.has(k) ? t(`fieldLabels.${k}`) : k}
                      value={fieldValueText(v)}
                      multiline
                    />
                  ))}
                </dl>

                <div className="flex flex-wrap gap-2">
                  {open.contact_id && (
                    <button
                      type="button"
                      onClick={() => {
                        setContactId(open.contact_id);
                        setOpenId(null);
                      }}
                      className="inline-flex h-10 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-foreground hover:bg-muted sm:h-8"
                    >
                      {t("openContact")}
                    </button>
                  )}
                  {open.deal_id && (
                    <button
                      type="button"
                      disabled={dealLoading}
                      onClick={() => openDeal(open.deal_id!)}
                      className="inline-flex h-10 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-foreground hover:bg-muted disabled:opacity-60 sm:h-8"
                    >
                      {dealLoading && <Loader2 className="size-3.5 animate-spin" />}
                      {t("openDeal")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      void setRead(open, false);
                      setOpenId(null);
                    }}
                    className="inline-flex h-10 items-center rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground sm:h-8"
                  >
                    {t("markUnread")}
                  </button>
                </div>

                {(open.source_url || open.user_agent || open.ip) && (
                  <dl className="grid gap-2 border-t border-border pt-4 text-xs">
                    {open.source_url && (
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">{t("sourceUrl")}</dt>
                        <dd className="break-all text-foreground">
                          {/^https?:\/\//i.test(open.source_url) ? (
                            <a
                              href={open.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              {open.source_url}
                              <ExternalLink className="size-3 shrink-0" />
                            </a>
                          ) : (
                            open.source_url
                          )}
                        </dd>
                      </div>
                    )}
                    <Field label={t("ip")} value={open.ip} small />
                    <Field label={t("userAgent")} value={open.user_agent} small />
                  </dl>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {deal && (
        <DealForm
          open={!!deal}
          onOpenChange={(o) => {
            if (!o) setDeal(null);
          }}
          deal={deal.deal}
          pipelineId={deal.deal.pipeline_id}
          stages={deal.stages}
          onSaved={() => undefined}
        />
      )}

      <ContactDetailView
        open={!!contactId}
        onOpenChange={(o) => {
          if (!o) setContactId(null);
        }}
        contactId={contactId}
        onUpdated={() => undefined}
      />
    </div>
  );
}

function Field({
  label,
  value,
  multiline,
  small,
}: {
  label: string;
  value: string | null | undefined;
  multiline?: boolean;
  small?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className={cn("text-muted-foreground", small ? "text-xs" : "text-xs font-medium")}>{label}</dt>
      <dd className={cn("break-words text-foreground", multiline && "whitespace-pre-wrap", small && "text-xs")}>
        {value}
      </dd>
    </div>
  );
}
