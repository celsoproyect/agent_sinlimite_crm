"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Loader2 } from "lucide-react";
import type { PostFunnel } from "@/lib/instagram/report";
import { REPORT_PRESETS, presetRange, type ReportPreset } from "@/lib/reports/range";
import { apiErrorText } from "./instagram-utils";

type PostInfo = { caption: string | null; permalink: string | null; thumbnail: string | null; kind: string | null };
type ReportData =
  | { migrated: false }
  | { migrated: true; posts: PostFunnel[]; total: PostFunnel; postInfo: Record<string, PostInfo> };

const COLUMNS = ["comments", "byRule", "byAi", "dmsSent", "replied", "leads", "sales"] as const;

function money(revenue: Record<string, number>): string {
  const parts = Object.entries(revenue).filter(([, v]) => v > 0);
  if (parts.length === 0) return "—";
  return parts.map(([cur, v]) => `${cur} ${Math.round(v).toLocaleString("es-DO")}`).join(" · ");
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

// Resultados (module instagram_reports): per post, comments → DMs → the
// customer answered → leads (deals) → sales, for a business-local range.
export function InstagramReportPanel() {
  const t = useTranslations("Instagram");
  const tr = useTranslations("Reports");
  const [preset, setPreset] = useState<ReportPreset>("last30");
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    setError(null);
    const range = presetRange(preset);
    const res = await fetch(`/api/instagram/report?from=${range.from}&to=${range.to}`).catch(() => null);
    if (!res?.ok) {
      setError(res ? await apiErrorText(res, t) : t("errors.generic"));
      return;
    }
    setData((await res.json()) as ReportData);
  }, [preset, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reloads when the range changes
    void load();
  }, [load]);

  const label = (id: string | null, info?: PostInfo) => {
    if (!id) return t("unknownPost");
    const caption = info?.caption?.replace(/\s+/g, " ").trim();
    if (caption) return caption.length > 60 ? `${caption.slice(0, 60)}…` : caption;
    return info?.kind === "REELS" ? t("reel") : t("post");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-2">
        {REPORT_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPreset(p)}
            className={
              preset === p
                ? "min-h-9 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground sm:min-h-0"
                : "min-h-9 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-0"
            }
          >
            {tr(`presets.${p}`)}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("reportHint")}</p>

      {error ? (
        <p className="rounded-xl border border-border bg-card p-6 text-sm text-destructive shadow-sm">{error}</p>
      ) : !data ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : !data.migrated ? (
        <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">{t("needsMigration082")}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t("report.comments")} value={String(data.total.comments)} />
            <Stat label={t("report.dmsSent")} value={String(data.total.dmsSent)} sub={pct(data.total.dmsSent, data.total.comments)} />
            <Stat label={t("report.leads")} value={String(data.total.leads)} sub={pct(data.total.leads, data.total.dmsSent)} />
            <Stat label={t("report.sales")} value={String(data.total.sales)} sub={money(data.total.revenue)} />
          </div>
          {data.total.queued > 0 && <p className="text-xs text-muted-foreground">{t("reportQueued", { count: data.total.queued })}</p>}
          {data.posts.length === 0 ? (
            <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">{t("reportEmpty")}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t("report.post")}</th>
                    {COLUMNS.map((c) => (
                      <th key={c} className="px-2 py-2 text-right font-medium">
                        {t(`report.${c}`)}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right font-medium">{t("report.revenue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.posts]
                    .sort((a, b) => b.comments - a.comments)
                    .map((p) => {
                      const info = p.mediaId ? data.postInfo[p.mediaId] : undefined;
                      return (
                        <tr key={p.mediaId ?? "none"} className="border-t border-border">
                          <td className="max-w-[16rem] px-3 py-2">
                            <div className="flex items-center gap-2">
                              {info?.thumbnail && (
                                // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN URLs
                                <img src={info.thumbnail} alt="" className="h-9 w-9 shrink-0 rounded object-cover" loading="lazy" />
                              )}
                              <span className="line-clamp-2 break-words text-foreground">{label(p.mediaId, info)}</span>
                              {info?.permalink && (
                                <a href={info.permalink} target="_blank" rel="noreferrer" aria-label={t("openOnInstagram")}>
                                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-primary" />
                                </a>
                              )}
                            </div>
                          </td>
                          {COLUMNS.map((c) => (
                            <td key={c} className="px-2 py-2 text-right tabular-nums text-foreground">
                              {p[c]}
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right tabular-nums text-foreground">{money(p.revenue)}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold text-foreground">{value}</p>
      {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
