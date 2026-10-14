"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Contact, RestaurantArea, RestaurantSettings, RestaurantTable } from "@/types";
import { businessDate, businessTime } from "@/lib/business-timezone";
import { bookingReference } from "@/lib/bookings/reference";
import { bookingDisplayName, bookingDisplayPhone } from "@/lib/bookings/ranges";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  DURATION_PRESETS,
  SELECT_CLASS,
  apiErrorText,
  bookableTables,
  durationOf,
  formatMinutes,
  type Reservation,
} from "./restaurant-utils";

interface ReservationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Business-local day preselected (YYYY-MM-DD). */
  defaultDate: string;
  /** "HH:mm" preselected (a click on the calendar). */
  defaultTime?: string;
  /** Set = edit this reservation (move it, change its people, length,
   *  status or notes) instead of creating one. */
  reservation?: Reservation | null;
  settings: RestaurantSettings;
  tables: RestaurantTable[];
  areas: RestaurantArea[];
  onSaved: () => void;
}

/** "Nueva reserva": a table reservation taken by the team. Tables are picked
 *  automatically unless some are chosen here; the length defaults to the
 *  restaurant's (90 min unless changed). With `reservation` it edits that
 *  one: a new date, time, length or party re-picks its tables, and the
 *  team can pick them by hand (also on the AI's reservations), which holds
 *  them for that date and time. */
export function ReservationFormDialog(props: ReservationFormDialogProps) {
  const t = useTranslations("Restaurant");
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="border-border bg-popover max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {props.reservation ? t("editReservation") : t("newReservation")}
          </DialogTitle>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts from the
            reservation (or blank). */}
        {props.open && <ReservationForm key={props.reservation?.id ?? "new"} {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ReservationForm({
  onOpenChange,
  defaultDate,
  defaultTime,
  reservation,
  settings,
  tables,
  areas,
  onSaved,
}: ReservationFormDialogProps) {
  const t = useTranslations("Restaurant");
  const editing = reservation ?? null;
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState("");
  const initialDate = editing ? businessDate(editing.starts_at) : defaultDate;
  const initialTime = editing ? businessTime(editing.starts_at) : (defaultTime ?? "19:00");
  const initialParty = String(editing?.party_size ?? 2);
  const initialDuration = String(editing ? durationOf(editing) : settings.default_duration_minutes);
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [party, setParty] = useState(initialParty);
  const [duration, setDuration] = useState(initialDuration);
  const initialTables = useMemo(() => [...(editing?.table_ids ?? [])].sort(), [editing]);
  const [tableIds, setTableIds] = useState<string[]>(initialTables);
  const initialSeating: "joined" | "separate" = editing?.seating === "separate" ? "separate" : "joined";
  const [seating, setSeating] = useState<"joined" | "separate">(initialSeating);
  const [occasion, setOccasion] = useState(editing?.occasion ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [status, setStatus] = useState<string>(editing?.status ?? "confirmed");
  const [force, setForce] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) return;
    createClient()
      .from("contacts")
      .select("*")
      .order("name")
      .then(({ data }) => setContacts((data ?? []) as Contact[]));
  }, [editing]);

  const choosable = useMemo(() => bookableTables(tables), [tables]);
  const areaName = useMemo(() => new Map(areas.map((a) => [a.id, a.name])), [areas]);
  const presets = useMemo(
    () => [...new Set([settings.default_duration_minutes, ...DURATION_PRESETS])].sort((a, b) => a - b),
    [settings.default_duration_minutes],
  );

  function toggleTable(id: string) {
    setTableIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function saveEdit(r: Reservation) {
    if (!date || !time || !Number(party)) {
      toast.error(t("errors.required_fields"));
      return;
    }
    const body: Record<string, unknown> = {};
    // A new date, time, length or party size re-checks and re-picks the
    // tables on the server (rescheduleTableReservation).
    if (date !== initialDate || time !== initialTime || party !== initialParty || duration !== initialDuration) {
      body.date = date;
      body.time = time;
      body.party_size = Number(party);
      body.duration_minutes = duration ? Number(duration) : undefined;
    }
    // Tables chosen by hand: held for the (new) date and time; a table
    // taken then answers 409 with its name.
    const tablesChanged = [...tableIds].sort().join(",") !== initialTables.join(",");
    if (tableIds.length > 0 && (tablesChanged || (tableIds.length > 1 && seating !== initialSeating))) {
      body.table_ids = tableIds;
      body.seating = seating;
      body.party_size = Number(party);
      body.duration_minutes = duration ? Number(duration) : undefined;
    }
    if (occasion !== (r.occasion ?? "")) body.occasion = occasion || null;
    if (notes !== (r.notes ?? "")) body.notes = notes || null;
    if (status !== r.status) body.status = status;
    if (Object.keys(body).length === 0) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/restaurant/reservations/${r.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    toast.success(t("reservationUpdated"));
    onOpenChange(false);
    onSaved();
  }

  async function save() {
    if (editing) return saveEdit(editing);
    if (!contactId || !date || !time || !Number(party)) {
      toast.error(t("errors.required_fields"));
      return;
    }
    setSaving(true);
    const res = await fetch("/api/restaurant/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: contactId,
        date,
        time,
        party_size: Number(party),
        duration_minutes: duration ? Number(duration) : undefined,
        table_ids: tableIds,
        seating,
        occasion: occasion || null,
        notes: notes || null,
        force,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    const json = (await res.json().catch(() => null)) as {
      reference?: string;
    } | null;
    toast.success(json?.reference ? t("reservationSavedRef", { reference: json.reference }) : t("reservationSaved"));
    onOpenChange(false);
    onSaved();
  }

  return (
    <>
      <div className="space-y-4 py-2">
        {editing ? (
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <p className="font-medium text-foreground">{bookingDisplayName(editing) || "—"}</p>
            <p className="text-xs text-muted-foreground">
              {bookingReference(editing.id, "table")}
              {bookingDisplayPhone(editing) ? ` · ${bookingDisplayPhone(editing)}` : ""}
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("contact")}</Label>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={SELECT_CLASS}>
              <option value="">{t("selectContact")}</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.phone}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("date")}</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border-border bg-muted"
            />
          </div>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("time")}</Label>
            <Input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="border-border bg-muted"
            />
          </div>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("people")}</Label>
            <Input
              type="number"
              min={1}
              value={party}
              onChange={(e) => setParty(e.target.value)}
              className="border-border bg-muted"
            />
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("durationMinutes")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={15}
              step={15}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="border-border bg-muted w-24"
            />
            {presets.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setDuration(String(m))}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs",
                  Number(duration) === m
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {formatMinutes(t, m)}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            {t("durationHint", { default: settings.default_duration_minutes })}
          </p>
        </div>

        {editing && (
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("statusLabel")}</Label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={SELECT_CLASS}>
              {(["confirmed", "completed", "no_show", "cancelled"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">{t("editMoveHint")}</p>
          </div>
        )}

        {(!editing || status === "confirmed" || status === "completed") && (
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{editing ? t("tablesAssigned") : t("tablesOptional")}</Label>
          {choosable.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("noTablesYet")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {choosable.map((tb) => {
                const on = tableIds.includes(tb.id);
                const area = tb.area_id ? areaName.get(tb.area_id) : null;
                return (
                  <button
                    key={tb.id}
                    type="button"
                    onClick={() => toggleTable(tb.id)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-left text-xs",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {tb.name} · {t("seatsRange", { min: tb.min_party, max: tb.max_party })}
                    {area ? ` · ${area}` : ""}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            {editing ? t("tablesManualHint") : t("tablesAutoHint")}
          </p>
        </div>
        )}

        {tableIds.length > 1 && (!editing || status === "confirmed" || status === "completed") && (
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("seating")}</Label>
            <select
              value={seating}
              onChange={(e) => setSeating(e.target.value === "separate" ? "separate" : "joined")}
              className={SELECT_CLASS}
            >
              <option value="joined">{t("seatingJoined")}</option>
              <option value="separate">{t("seatingSeparate")}</option>
            </select>
            <p className="text-muted-foreground text-xs">{t("seatingHint")}</p>
          </div>
        )}

        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("occasion")}</Label>
          <Input
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
            placeholder={t("occasionPlaceholder")}
            className="border-border bg-muted"
          />
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("notes")}</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="border-border bg-muted"
          />
        </div>

        {!editing && (
        <label className="text-foreground flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="accent-primary mt-0.5 h-4 w-4"
          />
          <span>
            {t("force")}
            <span className="text-muted-foreground block text-xs">{t("forceHint")}</span>
          </span>
        </label>
        )}
      </div>

      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t("cancel")}
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? t("saving") : t("save")}
        </Button>
      </DialogFooter>
    </>
  );
}
