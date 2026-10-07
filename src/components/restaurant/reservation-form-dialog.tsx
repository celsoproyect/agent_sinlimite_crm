"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Contact, RestaurantArea, RestaurantSettings, RestaurantTable } from "@/types";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DURATION_PRESETS, SELECT_CLASS, apiErrorText, bookableTables, formatMinutes } from "./restaurant-utils";

interface ReservationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Business-local day preselected (YYYY-MM-DD). */
  defaultDate: string;
  settings: RestaurantSettings;
  tables: RestaurantTable[];
  areas: RestaurantArea[];
  onSaved: () => void;
}

/** "Nueva reserva": a table reservation taken by the team. Tables are picked
 *  automatically unless some are chosen here; the length defaults to the
 *  restaurant's (90 min unless changed). */
export function ReservationFormDialog(props: ReservationFormDialogProps) {
  const t = useTranslations("Restaurant");
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="border-border bg-popover max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("newReservation")}</DialogTitle>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts blank. */}
        {props.open && <ReservationForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ReservationForm({ onOpenChange, defaultDate, settings, tables, areas, onSaved }: ReservationFormDialogProps) {
  const t = useTranslations("Restaurant");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("19:00");
  const [party, setParty] = useState("2");
  const [duration, setDuration] = useState(String(settings.default_duration_minutes));
  const [tableIds, setTableIds] = useState<string[]>([]);
  const [seating, setSeating] = useState<"joined" | "separate">("joined");
  const [occasion, setOccasion] = useState("");
  const [notes, setNotes] = useState("");
  const [force, setForce] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    createClient()
      .from("contacts")
      .select("*")
      .order("name")
      .then(({ data }) => setContacts((data ?? []) as Contact[]));
  }, []);

  const choosable = useMemo(() => bookableTables(tables), [tables]);
  const areaName = useMemo(() => new Map(areas.map((a) => [a.id, a.name])), [areas]);
  const presets = useMemo(
    () => [...new Set([settings.default_duration_minutes, ...DURATION_PRESETS])].sort((a, b) => a - b),
    [settings.default_duration_minutes],
  );

  function toggleTable(id: string) {
    setTableIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function save() {
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

        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("tablesOptional")}</Label>
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
          <p className="text-muted-foreground text-xs">{t("tablesAutoHint")}</p>
        </div>

        {tableIds.length > 1 && (
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
