"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import type { Contact, EventHall, EventPackage, EventSettings } from "@/types";
import { createClient } from "@/lib/supabase/client";
import { businessToday } from "@/lib/business-timezone";
import { addDaysISO } from "@/lib/bookings/ranges";
import { effectivePolicy, quoteEvent } from "@/lib/events/settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney, KNOWN_ERRORS, sendJson } from "./event-utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  halls: EventHall[];
  packages: EventPackage[];
  settings: EventSettings;
  onCreated: () => Promise<void> | void;
}

const selectClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

/** A request the team enters by hand (a phone call, a walk-in). It goes
 *  through the same checks as the AI's, unless "force" is on. */
export function EventRequestDialog({ open, onOpenChange, ...rest }: Props) {
  const t = useTranslations("Events");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("form.title")}</DialogTitle>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts from a blank form. */}
        {open && <RequestForm onClose={() => onOpenChange(false)} {...rest} />}
      </DialogContent>
    </Dialog>
  );
}

function RequestForm({
  halls,
  packages,
  settings,
  onCreated,
  onClose,
}: Omit<Props, "open" | "onOpenChange"> & { onClose: () => void }) {
  const t = useTranslations("Events");
  const locale = useLocale();
  const supabase = useMemo(() => createClient(), []);
  const activeHalls = useMemo(() => halls.filter((h) => h.active), [halls]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState("");
  const [hallId, setHallId] = useState(activeHalls[0]?.id ?? "");
  const [packageId, setPackageId] = useState("");
  const [date, setDate] = useState(() => addDaysISO(businessToday(), Math.max(settings.min_notice_days, 1)));
  const [time, setTime] = useState("18:00");
  const [hours, setHours] = useState("");
  const [guests, setGuests] = useState("50");
  const [eventType, setEventType] = useState("");
  const [notes, setNotes] = useState("");
  const [force, setForce] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("contacts")
      .select("*")
      .order("name")
      .then(({ data }) => {
        if (!cancelled) setContacts((data ?? []) as Contact[]);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const hall = activeHalls.find((h) => h.id === hallId);
  const hallPackages = packages.filter((p) => p.active && (!p.hall_id || p.hall_id === hallId));
  const pkg = hallPackages.find((p) => p.id === packageId);

  // Estimate shown before saving; the server computes the real quote.
  const estimate = (() => {
    if (!hall) return null;
    const g = Number(guests);
    const h = Number(hours || pkg?.duration_hours || hall.min_hours || 1);
    if (!(g >= 1) || !(h > 0)) return null;
    return quoteEvent({ hall, pkg: pkg ?? null, guests: g, hours: h, policy: effectivePolicy(settings, hall) });
  })();

  async function submit() {
    if (!contactId || !hallId || !date || !time) {
      toast.error(t("errors.missing_fields"));
      return;
    }
    setSaving(true);
    const res = await sendJson<{ reference?: string }>("/api/events/requests", "POST", {
      contact_id: contactId,
      hall_id: hallId,
      package_id: packageId || undefined,
      date,
      time,
      hours: hours || undefined,
      guests: Number(guests),
      event_type: eventType || undefined,
      notes: notes || undefined,
      force,
    });
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
    toast.success(t("form.created", { ref: res.data.reference ?? "" }));
    onClose();
    await onCreated();
  }

  if (activeHalls.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">{t("form.noHalls")}</p>;
  }

  return (
    <>
      <div className="space-y-3 py-1">
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("form.contact")}</Label>
          <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={selectClass}>
            <option value="">{t("form.selectContact")}</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.phone}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("form.hall")}</Label>
            <select
              value={hallId}
              onChange={(e) => {
                setHallId(e.target.value);
                setPackageId("");
              }}
              className={selectClass}
            >
              {activeHalls.map((h) => (
                <option key={h.id} value={h.id}>
                  {t("form.hallOption", { name: h.name, max: h.capacity_max })}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("form.package")}</Label>
            <select value={packageId} onChange={(e) => setPackageId(e.target.value)} className={selectClass}>
              <option value="">{t("form.noPackage")}</option>
              {hallPackages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
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
              placeholder={String(pkg?.duration_hours ?? hall?.min_hours ?? "")}
              className="border-border bg-background"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("form.guests")}</Label>
            <Input type="number" min={1} value={guests} onChange={(e) => setGuests(e.target.value)} className="border-border bg-background" />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("form.type")}</Label>
          <Input list="event-types" value={eventType} onChange={(e) => setEventType(e.target.value)} className="border-border bg-background" />
          <datalist id="event-types">
            {settings.event_types.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("form.notes")}</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="border-border bg-background" />
        </div>
        {estimate && estimate.total != null && (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-foreground">
            {t("form.estimate", { amount: formatMoney(estimate.total, settings.currency, locale) ?? "" })}
            {estimate.deposit != null &&
              ` · ${t("board.deposit", { amount: formatMoney(estimate.deposit, settings.currency, locale) ?? "" })}`}
          </p>
        )}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-foreground">{t("form.force")}</p>
            <p className="text-xs text-muted-foreground">{t("form.forceHelp")}</p>
          </div>
          <Switch checked={force} onCheckedChange={setForce} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} className="border-border">
          {t("common.cancel")}
        </Button>
        <Button onClick={submit} disabled={saving || !contactId} className="bg-primary text-primary-foreground hover:bg-primary/90">
          {saving ? t("common.saving") : t("form.submit")}
        </Button>
      </DialogFooter>
    </>
  );
}
