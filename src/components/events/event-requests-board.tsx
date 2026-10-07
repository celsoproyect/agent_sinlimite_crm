"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarDays, Pencil, Users } from "lucide-react";
import type { Booking, EventHall, EventSettings, EventStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { bookingReference } from "@/lib/bookings/reference";
import { bookingDisplayName, bookingDisplayPhone } from "@/lib/bookings/ranges";
import { businessDate, businessTime } from "@/lib/business-timezone";
import { effectivePolicy, nextEventStatuses } from "@/lib/events/settings";
import { EVENT_COLUMNS, EVENT_STATUS_TONE, formatMoney, KNOWN_ERRORS, sendJson } from "./event-utils";

interface Props {
  bookings: Booking[];
  halls: EventHall[];
  settings: EventSettings;
  canEdit: boolean;
  onChanged: () => Promise<void> | void;
}

/** The column an event sits in. A cancelled booking row counts as
 *  cancelled whatever its event status says. */
export function eventColumn(b: Booking): EventStatus {
  if (b.status === "cancelled") return "cancelled";
  return b.event_status ?? "requested";
}

interface QuoteDraft {
  booking: Booking;
  /** Status to move to on save (approving + quoting in one step), if any. */
  moveTo: EventStatus | null;
  quote: string;
  deposit: string;
  notes: string;
}

/** Event requests as a pipeline: requested → quoted → deposit paid →
 *  confirmed → completed, plus cancelled. */
export function EventRequestsBoard({ bookings, halls, settings, canEdit, onChanged }: Props) {
  const t = useTranslations("Events");
  const locale = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const hallById = useMemo(() => new Map(halls.map((h) => [h.id, h])), [halls]);

  const grouped = useMemo(() => {
    const map = new Map<EventStatus, Booking[]>(EVENT_COLUMNS.map((s) => [s, []]));
    for (const b of bookings) map.get(eventColumn(b))?.push(b);
    return map;
  }, [bookings]);

  const anyDeposit = settings.deposit_required || halls.some((h) => effectivePolicy(settings, h).depositRequired);
  const columns = EVENT_COLUMNS.filter((s) => s !== "deposit_paid" || anyDeposit || (grouped.get(s)?.length ?? 0) > 0);

  const fail = (code: string, message?: string) =>
    toast.error(code === "unavailable" && message ? message : KNOWN_ERRORS.has(code) ? t(`errors.${code}`) : t("errors.failed"));

  async function patch(b: Booking, body: Record<string, unknown>): Promise<boolean> {
    setBusyId(b.id);
    const res = await sendJson(`/api/events/requests/${b.id}`, "PATCH", body);
    setBusyId(null);
    if (!res.ok) {
      fail(res.code, res.message);
      return false;
    }
    await onChanged();
    return true;
  }

  function openQuote(b: Booking, moveTo: EventStatus | null) {
    setQuote({
      booking: b,
      moveTo,
      quote: b.quote_amount == null ? "" : String(b.quote_amount),
      deposit: b.deposit_amount == null ? "" : String(b.deposit_amount),
      notes: b.notes ?? "",
    });
  }

  async function move(b: Booking, to: EventStatus) {
    if (to === "quoted") return openQuote(b, to);
    if (to === "cancelled" && !confirm(t("board.confirmCancel", { ref: bookingReference(b.id, "event") }))) return;
    if (await patch(b, { event_status: to })) toast.success(t(`board.moved.${to}`));
  }

  async function saveQuote() {
    if (!quote) return;
    const body: Record<string, unknown> = { notes: quote.notes };
    if (quote.moveTo) body.event_status = quote.moveTo;
    if (quote.quote.trim() !== "") body.quote_amount = quote.quote;
    // Blank deposit with a quote: the server works it out from the policy.
    if (quote.deposit.trim() !== "") body.deposit_amount = quote.deposit;
    setSaving(true);
    const ok = await patch(quote.booking, body);
    setSaving(false);
    if (ok) {
      toast.success(quote.moveTo ? t(`board.moved.${quote.moveTo}`) : t("common.saved"));
      setQuote(null);
    }
  }

  async function markNoShow(b: Booking) {
    if (await patch(b, { status: "no_show" })) toast.success(t("board.noShowDone"));
  }

  const quoteHall = quote ? hallById.get(quote.booking.event_hall_id ?? "") : undefined;
  const quotePolicy = quote ? effectivePolicy(settings, quoteHall) : null;

  return (
    <>
      <div className="-mx-1 overflow-x-auto px-1 pb-2">
        <div className="flex gap-3 md:grid md:min-w-[960px]" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
          {columns.map((status) => {
            const rows = grouped.get(status) ?? [];
            return (
              <div key={status} className="w-72 shrink-0 space-y-2 rounded-xl border border-border bg-muted/30 p-2 md:w-auto">
                <div className="flex items-center justify-between gap-2 px-1">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${EVENT_STATUS_TONE[status]}`}>{t(`status.${status}`)}</span>
                  <span className="text-xs text-muted-foreground">{rows.length}</span>
                </div>
                {rows.length === 0 ? (
                  <p className="px-1 py-4 text-center text-xs text-muted-foreground">{t("board.emptyColumn")}</p>
                ) : (
                  rows.map((b) => {
                    const hall = hallById.get(b.event_hall_id ?? "");
                    const policy = effectivePolicy(settings, hall);
                    const from = eventColumn(b);
                    const next =
                      canEdit && b.status !== "cancelled" && b.status !== "no_show"
                        ? nextEventStatuses(from, { depositRequired: policy.depositRequired || from === "quoted" })
                        : [];
                    const currency = b.currency || settings.currency;
                    const quoteText = formatMoney(b.quote_amount, currency, locale);
                    const depositText = formatMoney(b.deposit_amount, currency, locale);
                    const past = new Date(b.starts_at).getTime() < Date.now();
                    const busy = busyId === b.id;
                    return (
                      <div key={b.id} className={`space-y-1.5 rounded-lg border bg-card p-2.5 text-xs ${b.is_sample ? "border-dashed border-primary/50" : "border-border"}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="break-words text-sm font-medium text-foreground">{bookingDisplayName(b) || t("board.noName")}</p>
                            <p className="text-muted-foreground">
                              {bookingReference(b.id, "event")}
                              {bookingDisplayPhone(b) ? ` · ${bookingDisplayPhone(b)}` : ""}
                            </p>
                          </div>
                          {canEdit && b.status !== "cancelled" && (
                            <button type="button" onClick={() => openQuote(b, null)} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("board.editQuote")}>
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {b.event_type && <span className="rounded bg-muted px-1.5 py-0.5 text-foreground">{b.event_type}</span>}
                          {b.is_sample && <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">{t("common.sample")}</span>}
                          {b.status === "no_show" && <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">{t("board.noShow")}</span>}
                        </div>
                        <p className="flex items-center gap-1 text-foreground">
                          <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          {businessDate(b.starts_at)} · {businessTime(b.starts_at)}–{businessTime(b.ends_at)}
                        </p>
                        <p className="flex items-center gap-1 text-foreground">
                          <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          {t("board.guests", { count: b.party_size ?? 0 })}
                          {hall ? ` · ${hall.name}` : ""}
                        </p>
                        {(quoteText || depositText) && (
                          <p className="text-foreground">
                            {quoteText && t("board.quote", { amount: quoteText })}
                            {quoteText && depositText ? " · " : ""}
                            {depositText && t("board.deposit", { amount: depositText })}
                          </p>
                        )}
                        {b.deposit_paid_at && (
                          <p className="text-muted-foreground">{t("board.depositPaidOn", { date: businessDate(b.deposit_paid_at) })}</p>
                        )}
                        {b.notes && <p className="line-clamp-3 break-words text-muted-foreground">{b.notes}</p>}
                        {(next.length > 0 || (canEdit && from === "confirmed" && past && b.status !== "no_show")) && (
                          <div className="flex flex-wrap gap-1 pt-1">
                            {next.map((to) => (
                              <Button
                                key={to}
                                size="sm"
                                variant={to === "cancelled" ? "ghost" : "outline"}
                                disabled={busy}
                                onClick={() => move(b, to)}
                                className={`h-auto min-h-7 whitespace-normal px-2 py-1 text-left text-xs ${to === "cancelled" ? "text-destructive hover:text-destructive" : "border-border"}`}
                              >
                                {t(`board.action.${to}`)}
                              </Button>
                            ))}
                            {canEdit && from === "confirmed" && past && b.status !== "no_show" && (
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => markNoShow(b)} className="h-auto min-h-7 whitespace-normal px-2 py-1 text-xs text-muted-foreground">
                                {t("board.markNoShow")}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Dialog open={!!quote} onOpenChange={(open) => !open && setQuote(null)}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {quote?.moveTo === "quoted" ? t("board.approveTitle") : t("board.editQuote")}
            </DialogTitle>
          </DialogHeader>
          {quote && (
            <div className="space-y-3 py-1">
              <p className="text-sm text-muted-foreground">
                {bookingDisplayName(quote.booking)} · {bookingReference(quote.booking.id, "event")}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("board.quoteLabel", { currency: quote.booking.currency || settings.currency })}</Label>
                  <Input type="number" min={0} value={quote.quote} onChange={(e) => setQuote({ ...quote, quote: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("board.depositLabel")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={quote.deposit}
                    onChange={(e) => setQuote({ ...quote, deposit: e.target.value })}
                    placeholder={quotePolicy?.depositRequired ? t("board.depositAuto", { pct: quotePolicy.depositPercent }) : t("board.depositNone")}
                    className="border-border bg-background"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("board.quoteHelp")}</p>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("form.notes")}</Label>
                <Textarea rows={3} value={quote.notes} onChange={(e) => setQuote({ ...quote, notes: e.target.value })} className="border-border bg-background" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuote(null)} className="border-border">
              {t("common.cancel")}
            </Button>
            <Button onClick={saveQuote} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {saving ? t("common.saving") : quote?.moveTo === "quoted" ? t("board.approveSave") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
