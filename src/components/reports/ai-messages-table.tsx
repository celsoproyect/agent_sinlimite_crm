"use client";

// Reportes → Mensajes atendidos por la IA: every message the AI sent in
// the selected range, with the customer message it answered. Filters:
// the page's range and channel, plus message kind and a text search.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bot, ChevronLeft, ChevronRight, ExternalLink, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { businessDate, businessTime } from "@/lib/business-timezone";
import type { DayRange } from "@/lib/bookings/ranges";
import type { ReportChannel } from "@/lib/reports/overview";
import type { AiMessageKind, AiMessagesPage } from "@/lib/reports/ai-messages";

const KINDS: AiMessageKind[] = ["all", "text", "media", "interactive"];
const PAGE_SIZE = 25;

export function AiMessagesTable({ range, channel }: { range: DayRange; channel: ReportChannel }) {
  const t = useTranslations("Reports.aiMessages");
  const tr = useTranslations("Reports");

  const [kind, setKind] = useState<AiMessageKind>("all");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AiMessagesPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Debounce the search box.
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  // Any filter change goes back to the first page.
  const filterKey = `${range.from}|${range.to}|${channel}|${kind}|${q}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const params = new URLSearchParams({
          from: range.from,
          to: range.to,
          channel,
          kind,
          q,
          page: String(page),
          pageSize: String(PAGE_SIZE),
        });
        const res = await fetch(`/api/reports/ai-messages?${params.toString()}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as AiMessagesPage;
        if (!cancelled) setData(json);
      } catch (err) {
        console.error("[reports] ai messages load failed:", err);
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, channel, kind, q, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Bot className="h-4 w-4 text-primary" />
            {t("title")}
            {data && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {data.total}
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn(
                  "min-h-9 rounded-md px-2.5 py-1 text-xs font-medium transition-colors sm:min-h-0",
                  kind === k
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`kinds.${k}`)}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-auto">
            <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-10 w-full pl-7 text-xs sm:h-8 sm:w-56"
            />
          </div>
        </div>
      </header>

      {failed ? (
        <p className="p-6 text-sm text-muted-foreground">{t("loadFailed")}</p>
      ) : loading && !data ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : !data || data.rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className={cn("divide-y divide-border", loading && "opacity-60")}>
          {data.rows.map((row) => (
            <li key={row.id} className="grid gap-2 px-4 py-3 sm:px-5 md:grid-cols-[160px_1fr_auto] md:gap-4">
              <div className="min-w-0 text-xs">
                <p className="truncate font-medium text-foreground">
                  {row.contactName || row.contactPhone || t("unknownContact")}
                </p>
                <p className="text-muted-foreground">
                  {businessDate(row.createdAt).split("-").reverse().join("/")} · {businessTime(row.createdAt)}
                </p>
                <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {row.channel === "web" ? tr("channels.web") : tr("channels.whatsapp")}
                </span>
              </div>
              <div className="min-w-0 space-y-1 text-sm">
                {row.question && (
                  <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                    <span className="font-medium">{t("question")}:</span> {row.question}
                  </p>
                )}
                <p className="line-clamp-3 break-words text-foreground">
                  {row.text || `[${t(`types.${typeKey(row.contentType)}`)}]`}
                </p>
              </div>
              <div className="flex items-start md:justify-end">
                <Link
                  href={`/inbox?c=${row.conversationId}`}
                  className="flex min-h-9 items-center gap-1 text-xs font-medium text-primary hover:underline md:min-h-0"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t("open")}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {data && data.total > data.pageSize && (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5 text-xs text-muted-foreground">
          <span>{t("pageOf", { page: data.page, pages })}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="flex min-h-10 min-w-10 items-center justify-center rounded p-1 hover:bg-muted disabled:opacity-40 sm:min-h-0 sm:min-w-0"
              aria-label={t("prev")}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages || loading}
              className="flex min-h-10 min-w-10 items-center justify-center rounded p-1 hover:bg-muted disabled:opacity-40 sm:min-h-0 sm:min-w-0"
              aria-label={t("next")}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

function typeKey(contentType: string): "media" | "interactive" | "text" {
  if (contentType === "interactive") return "interactive";
  if (contentType === "text") return "text";
  return "media";
}
