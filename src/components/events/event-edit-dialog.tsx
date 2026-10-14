"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { Booking, EventHall, EventSettings, EventStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { bookingReference } from "@/lib/bookings/reference";
import { bookingDisplayName, bookingDisplayPhone } from "@/lib/bookings/ranges";
import { businessDate, businessTime } from "@/lib/business-timezone";
import { effectivePolicy } from "@/lib/events/settings";
import { KNOWN_ERRORS, sendJson } from "./event-utils";

interface Props {
  /** The event being edited; null closes the dialog. */
  booking: Booking | null;
  /** Status to move to on save (approving + quoting in one step), if any. */
  moveTo: EventStatus | null;
  halls: EventHall[];
  settings: EventSettings;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

/** Edit an event: move it to another date, time or length, and set its
 *  quote, deposit and notes. Moving it sends its reminders again. */
export function EventEditDialog({ booking, moveTo, halls, settings, onClose, onSaved }: Props) {
  const t = useTranslations("Events");
  return (
    <Dialog open={!!booking} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {moveTo === "quoted" ? t("board.approveTitle") : t("board.editEvent")}
          </DialogTitle>
        </DialogHeader>
        {/* Keyed by booking, so every opening starts from its values. */}
        {booking && (
          <EditForm
            key={booking.id}
            booking={booking}
            moveTo={moveTo}
            halls={halls}
            settings={settings}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ booking, moveTo, halls, settings, onClose, onSaved }: Props & { booking: Booking }) {
  const t = useTranslations("Events");
  const initialDate = businessDate(booking.starts_at);
  const initialTime = businessTime(booking.starts_at);
  const initialHours = String(
    Math.round(((new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 3_600_000) * 100) / 100,
  );
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [hours, setHours] = useState(initialHours);
  const [quote, setQuote] = useState(booking.quote_amount == null ? "" : String(booking.quote_amount));
  const [deposit, setDeposit] = useState(booking.deposit_amount == null ? "" : String(booking.deposit_amount));
  const [notes, setNotes] = useState(booking.notes ?? "");
  const [saving, setSaving] = useState(false);
  const hall = halls.find((h) => h.id === booking.event_hall_id);
  const policy = effectivePolicy(settings, hall);
  const live = booking.status !== "cancelled" && booking.status !== "no_show";

  async function save() {
    const body: Record<string, unknown> = { notes };
    if (moveTo) body.event_status = moveTo;
    if (quote.trim() !== "") body.quote_amount = quote;
    // Blank deposit with a quote: the server works it out from the policy.
    if (deposit.trim() !== "") body.deposit_amount = deposit;
    if (date !== initialDate || time !== initialTime || hours !== initialHours) {
      body.date = date;
      body.time = time;
      body.hours = hours;
    }
    setSaving(true);
    const res = await sendJson(`/api/events/requests/${booking.id}`, "PATCH", body);
    setSaving(false);
    if (!res.ok) {
      toast.error(
        res.code === "unavailable" && res.message
          ? res.message
          : KNOWN_ERRORS.has(res.code)
            ? t(`errors.${res.code}`)
            : t("errors.failed"),
      );
      return;
    }
    toast.success(moveTo ? t(`board.moved.${moveTo}`) : body.date ? t("board.rescheduled") : t("common.saved"));
    onClose();
    await onSaved();
  }

  return (
    <>
      <div className="space-y-3 py-1">
        <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
          <p className="font-medium text-foreground">{bookingDisplayName(booking) || t("board.noName")}</p>
          <p className="text-xs text-muted-foreground">
            {bookingReference(booking.id, "event")}
            {bookingDisplayPhone(booking) ? ` · ${bookingDisplayPhone(booking)}` : ""}
            {hall ? ` · ${hall.name}` : ""}
            {booking.event_type ? ` · ${booking.event_type}` : ""}
          </p>
        </div>
        {live && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("form.date")}</Label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border-border bg-background" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("form.time")}</Label>
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="border-border bg-background" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("form.hours")}</Label>
                <Input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  className="border-border bg-background"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("board.rescheduleHelp")}</p>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("board.quoteLabel", { currency: booking.currency || settings.currency })}</Label>
            <Input type="number" min={0} value={quote} onChange={(e) => setQuote(e.target.value)} className="border-border bg-background" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("board.depositLabel")}</Label>
            <Input
              type="number"
              min={0}
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
              placeholder={policy.depositRequired ? t("board.depositAuto", { pct: policy.depositPercent }) : t("board.depositNone")}
              className="border-border bg-background"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("board.quoteHelp")}</p>
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("form.notes")}</Label>
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="border-border bg-background" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} className="border-border">
          {t("common.cancel")}
        </Button>
        <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90">
          {saving ? t("common.saving") : moveTo === "quoted" ? t("board.approveSave") : t("common.save")}
        </Button>
      </DialogFooter>
    </>
  );
}
