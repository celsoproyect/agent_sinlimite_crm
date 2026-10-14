"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Trash2 } from "lucide-react";
import type { BookingStatus, Contact } from "@/types";
import type { Property } from "@/lib/real-estate/search";
import { createClient } from "@/lib/supabase/client";
import { businessDate, businessLocalToInstant, businessTime } from "@/lib/business-timezone";
import { bookingDisplayName, bookingDisplayPhone } from "@/lib/bookings/ranges";
import { bookingReference } from "@/lib/bookings/reference";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SELECT_CLASS, propertyLabel, type Advisor, type Visit } from "./properties-utils";

type ScheduleProblem = "holiday" | "day_off" | "time_off" | "outside_hours";

const STATUSES: BookingStatus[] = ["confirmed", "completed", "no_show", "cancelled"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The visit being edited; null creates one. */
  visit: Visit | null;
  properties: Property[];
  advisors: Advisor[];
  defaultDate?: string;
  defaultTime?: string;
  onSaved: () => void;
}

/** Create or edit a property visit: an appointment with an advisor and a
 *  property_id, saved through /api/bookings like any agenda booking. */
export function VisitFormDialog({ open, onOpenChange, visit, ...rest }: Props) {
  const t = useTranslations("Properties");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{visit ? t("editVisit") : t("newVisit")}</DialogTitle>
        </DialogHeader>
        {/* Keyed so every opening starts from the visit's own values. */}
        {open && (
          <VisitForm
            key={visit?.id ?? `new-${rest.defaultDate ?? ""}-${rest.defaultTime ?? ""}`}
            visit={visit}
            onClose={() => onOpenChange(false)}
            {...rest}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function VisitForm({
  visit,
  properties,
  advisors,
  defaultDate,
  defaultTime,
  onSaved,
  onClose,
}: Omit<Props, "open" | "onOpenChange"> & { onClose: () => void }) {
  const t = useTranslations("Properties");
  const tf = useTranslations("Agenda.form");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState(visit?.contact_id ?? "");
  const [propertyId, setPropertyId] = useState(visit?.property_id ?? "");
  const [advisorId, setAdvisorId] = useState(visit?.professional_id ?? "");
  const [date, setDate] = useState(visit ? businessDate(visit.starts_at) : (defaultDate ?? ""));
  const [time, setTime] = useState(visit ? businessTime(visit.starts_at) : (defaultTime ?? ""));
  const [minutes, setMinutes] = useState(() =>
    visit ? String(Math.round((new Date(visit.ends_at).getTime() - new Date(visit.starts_at).getTime()) / 60_000)) : "60",
  );
  const [status, setStatus] = useState<BookingStatus>(visit?.status ?? "confirmed");
  const [notes, setNotes] = useState(visit?.notes ?? "");
  const [problem, setProblem] = useState<ScheduleProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const advisor = advisors.find((a) => a.id === advisorId);

  useEffect(() => {
    if (visit) return;
    let cancelled = false;
    void createClient()
      .from("contacts")
      .select("*")
      .order("name")
      .then(({ data }) => {
        if (!cancelled) setContacts((data ?? []) as Contact[]);
      });
    return () => {
      cancelled = true;
    };
  }, [visit]);

  // Picking a property brings its advisor and their visit length.
  function pickProperty(id: string) {
    setPropertyId(id);
    setProblem(null);
    const p = properties.find((x) => x.id === id);
    if (p?.advisor_id && !advisorId) pickAdvisor(p.advisor_id);
  }

  function pickAdvisor(id: string) {
    setAdvisorId(id);
    setProblem(null);
    const a = advisors.find((x) => x.id === id);
    if (!visit && a?.slot_minutes) setMinutes(String(a.slot_minutes));
  }

  async function save(force = false) {
    const length = Number(minutes);
    if (!contactId || !propertyId || !date || !time) {
      toast.error(t("visitRequired"));
      return;
    }
    if (!Number.isFinite(length) || length < 5) {
      toast.error(t("visitInvalidLength"));
      return;
    }
    const startsAt = businessLocalToInstant(date, time);
    const endsAt = new Date(startsAt.getTime() + length * 60_000);
    const property = properties.find((p) => p.id === propertyId);
    const payload: Record<string, unknown> = {
      service: property ? t("visitService", { property: propertyLabel(property) }) : (visit?.service ?? ""),
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      notes: notes.trim() || null,
      property_id: propertyId,
      professional_id: advisorId || null,
      ...(force ? { force: true } : {}),
    };
    if (visit) {
      if (status !== visit.status) payload.status = status;
    } else {
      payload.contact_id = contactId;
    }
    setSaving(true);
    const res = await fetch(visit ? `/api/bookings/${visit.id}` : "/api/bookings", {
      method: visit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const json = (await res?.json().catch(() => null)) as { error?: string; reason?: string } | null;
      if (json?.error === "outside_doctor_hours") {
        setProblem((json.reason ?? "outside_hours") as ScheduleProblem);
        return;
      }
      toast.error(json?.error === "professional_busy" ? t("advisorBusy") : tf("toastFailedSave"));
      return;
    }
    toast.success(visit ? t("visitUpdated") : t("visitCreated"));
    onClose();
    onSaved();
  }

  async function remove() {
    if (!visit) return;
    setSaving(true);
    const res = await fetch(`/api/bookings/${visit.id}`, { method: "DELETE" }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      toast.error(tf("toastFailedDelete"));
      return;
    }
    toast.success(t("visitDeleted"));
    onClose();
    onSaved();
  }

  return (
    <>
      <div className="space-y-3 py-1">
        {visit ? (
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            <p className="font-medium text-foreground">{bookingDisplayName(visit) || "—"}</p>
            <p className="text-xs text-muted-foreground">
              {bookingReference(visit.id)}
              {bookingDisplayPhone(visit) ? ` · ${bookingDisplayPhone(visit)}` : ""}
            </p>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{tf("contact")}</Label>
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} className={SELECT_CLASS}>
              <option value="">{tf("selectContact")}</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.phone}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("visitProperty")}</Label>
          <select value={propertyId} onChange={(e) => pickProperty(e.target.value)} className={SELECT_CLASS}>
            <option value="">{t("selectProperty")}</option>
            {properties
              .filter((p) => p.active || p.id === propertyId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {propertyLabel(p)}
                </option>
              ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{t("fields.advisor")}</Label>
          <select value={advisorId} onChange={(e) => pickAdvisor(e.target.value)} className={SELECT_CLASS}>
            <option value="">{t("noAdvisor")}</option>
            {advisors
              .filter((a) => a.active || a.id === advisorId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="col-span-2 grid gap-1.5 sm:col-span-1">
            <Label className="text-muted-foreground">{tf("date")}</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setProblem(null);
              }}
              className="border-border bg-muted text-foreground"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{tf("startTime")}</Label>
            <Input
              type="time"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                setProblem(null);
              }}
              className="border-border bg-muted text-foreground"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("visitLengthShort")}</Label>
            <Input
              type="number"
              min={5}
              step={5}
              value={minutes}
              onChange={(e) => {
                setMinutes(e.target.value);
                setProblem(null);
              }}
              className="border-border bg-muted text-foreground"
            />
          </div>
        </div>

        {visit && (
          <div className="grid gap-1.5">
            <Label className="text-muted-foreground">{t("fields.status")}</Label>
            <select value={status} onChange={(e) => setStatus(e.target.value as BookingStatus)} className={SELECT_CLASS}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`visitStatus.${s}`)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid gap-1.5">
          <Label className="text-muted-foreground">{tf("notes")}</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={tf("notesPlaceholder")}
            className="min-h-[70px] border-border bg-muted text-foreground"
          />
        </div>

        {problem && (
          <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0 space-y-2">
              <p className="text-foreground">
                {problem === "holiday" || advisor
                  ? tf(`schedule_${problem}`, { doctor: advisor?.name ?? "" })
                  : tf(`schedule_${problem}_business`)}
              </p>
              <button
                type="button"
                onClick={() => save(true)}
                disabled={saving}
                className="min-h-9 rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50 sm:min-h-0"
              >
                {tf("saveAnyway")}
              </button>
            </div>
          </div>
        )}
      </div>

      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        {visit ? (
          confirmDelete ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t("confirmDeleteVisit")}</span>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="min-h-9 rounded px-2 py-1 text-muted-foreground hover:bg-muted sm:min-h-0"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={saving}
                className="min-h-9 rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50 sm:min-h-0"
              >
                {t("delete")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1 text-xs text-destructive hover:opacity-80"
            >
              <Trash2 className="h-3 w-3" />
              {t("delete")}
            </button>
          )
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="border-border">
            {t("cancel")}
          </Button>
          <Button onClick={() => save()} disabled={saving}>
            {saving ? tf("saving") : t("save")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
