"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Booking, ClinicServiceRow, Contact, Professional } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { businessDate, businessLocalToInstant, businessTime } from "@/lib/business-timezone";

interface BookingFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking?: Booking | null;
  defaultContactId?: string;
  defaultDate?: string;
  defaultStartTime?: string;
  /** Clinic module: the account's doctors. Empty/omitted hides the
   *  doctor picker (one shared agenda). */
  professionals?: Professional[];
  /** Clinic module, migration 067: the services. Empty hides the service
   *  picker. */
  services?: ClinicServiceRow[];
  /** Clinic module: migration 067 has run (shows the insurance field). */
  clinicExtended?: boolean;
  onSaved: () => void;
}

type ScheduleProblem = "holiday" | "day_off" | "time_off" | "outside_hours";

/** "HH:mm" plus `minutes`, capped at 23:59. */
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// The form shows and saves Santo Domingo wall-clock time, whatever the
// browser's own timezone is.
const toDateInput = businessDate;
const toTimeInput = businessTime;

export function BookingFormDialog({
  open,
  onOpenChange,
  booking,
  defaultContactId,
  defaultDate,
  defaultStartTime,
  professionals = [],
  services = [],
  clinicExtended = false,
  onSaved,
}: BookingFormDialogProps) {
  const t = useTranslations("Agenda.form");
  const supabase = createClient();

  const [contactId, setContactId] = useState("");
  const [service, setService] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [notes, setNotes] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [insurance, setInsurance] = useState("");
  const [scheduleProblem, setScheduleProblem] = useState<ScheduleProblem | null>(null);
  const clinicMode = professionals.length > 0;
  const withServices = clinicMode && clinicExtended && services.length > 0;
  const selectedDoctor = professionals.find((p) => p.id === professionalId);
  // Only the services the chosen doctor offers (their specialty, or any).
  const doctorServices = services.filter(
    (s) =>
      s.id === serviceId ||
      (s.active &&
        (!s.specialty_id || !selectedDoctor || selectedDoctor.specialty_ids.includes(s.specialty_id))),
  );

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Prop-driven reset every time the dialog opens or its target changes —
  // legitimate sync, not a derived-state anti-pattern.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setScheduleProblem(null);
    if (booking) {
      setContactId(booking.contact_id);
      setService(booking.service);
      setDate(toDateInput(booking.starts_at));
      setStartTime(toTimeInput(booking.starts_at));
      setEndTime(toTimeInput(booking.ends_at));
      setNotes(booking.notes ?? "");
      setProfessionalId(booking.professional_id ?? "");
      setServiceId(booking.clinic_service_id ?? "");
      setInsurance(booking.insurance ?? "");
    } else {
      setContactId(defaultContactId ?? "");
      setService("");
      setDate(defaultDate ?? "");
      setStartTime(defaultStartTime ?? "");
      setEndTime("");
      setNotes("");
      setProfessionalId("");
      setServiceId("");
      setInsurance("");
    }
  }, [open, booking, defaultContactId, defaultDate, defaultStartTime]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("contacts").select("*").order("name");
      if (cancelled) return;
      setContacts((data ?? []) as Contact[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  function pickService(id: string) {
    setServiceId(id);
    const picked = services.find((s) => s.id === id);
    if (!picked) return;
    setService(picked.name);
    if (startTime) setEndTime(addMinutes(startTime, picked.duration_minutes));
  }

  function changeStartTime(value: string) {
    setStartTime(value);
    setScheduleProblem(null);
    // A service fixes the length: keep the end time in step.
    const picked = services.find((s) => s.id === serviceId);
    if (picked && value) setEndTime(addMinutes(value, picked.duration_minutes));
  }

  async function handleSave(force = false) {
    if (!contactId || !date || !startTime || !endTime) {
      toast.error(t("required"));
      return;
    }
    const startsAt = businessLocalToInstant(date, startTime);
    const endsAt = businessLocalToInstant(date, endTime);
    if (endsAt <= startsAt) {
      toast.error(t("endBeforeStart"));
      return;
    }

    setSaving(true);
    const payload = {
      contact_id: contactId,
      service: service.trim(),
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      notes: notes.trim() || null,
      // Only clinic accounts send it, so the column (migration 066) is
      // never touched elsewhere.
      ...(clinicMode ? { professional_id: professionalId || null } : {}),
      // Same for the columns of migration 067.
      ...(clinicMode && clinicExtended
        ? { clinic_service_id: serviceId || null, insurance: insurance.trim() || null }
        : {}),
      ...(force ? { force: true } : {}),
    };

    const res = await fetch(
      booking ? `/api/bookings/${booking.id}` : "/api/bookings",
      {
        method: booking ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    setSaving(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.error === "outside_doctor_hours") {
        setScheduleProblem((json.reason ?? "outside_hours") as ScheduleProblem);
        return;
      }
      toast.error(res.status === 409 ? t("doctorBusy") : t("toastFailedSave"));
      return;
    }
    setScheduleProblem(null);
    toast.success(booking ? t("toastUpdated") : t("toastCreated"));
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!booking) return;
    setDeleting(true);
    const res = await fetch(`/api/bookings/${booking.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    toast.success(t("toastDeleted"));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-popover border-border">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {booking ? t("editBooking") : t("newBooking")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("contact")}</Label>
            <select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              <option value="">{t("selectContact")}</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.phone}
                </option>
              ))}
            </select>
          </div>

          {clinicMode && (
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("doctor")}</Label>
              <select
                value={professionalId}
                onChange={(e) => {
                  setProfessionalId(e.target.value);
                  setScheduleProblem(null);
                }}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t("noDoctor")}</option>
                {professionals
                  .filter((p) => p.active || p.id === professionalId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {withServices && (
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("clinicService")}</Label>
              <select
                value={serviceId}
                onChange={(e) => pickService(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t("noClinicService")}</option>
                {doctorServices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {t("clinicServiceOption", { name: s.name, minutes: s.duration_minutes })}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("service")}</Label>
            <Input
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder={t("servicePlaceholder")}
              className="border-border bg-muted text-foreground"
            />
          </div>

          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("date")}</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setScheduleProblem(null);
              }}
              className="border-border bg-muted text-foreground"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("startTime")}</Label>
              <Input
                type="time"
                value={startTime}
                onChange={(e) => changeStartTime(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("endTime")}</Label>
              <Input
                type="time"
                value={endTime}
                onChange={(e) => {
                  setEndTime(e.target.value);
                  setScheduleProblem(null);
                }}
                className="border-border bg-muted text-foreground"
              />
            </div>
          </div>

          {clinicMode && clinicExtended && (
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("insurance")}</Label>
              <Input
                value={insurance}
                onChange={(e) => setInsurance(e.target.value)}
                placeholder={t("insurancePlaceholder")}
                className="border-border bg-muted text-foreground"
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("notes")}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              className="min-h-[80px] border-border bg-muted text-foreground"
            />
          </div>

          {scheduleProblem && (
            <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <div className="min-w-0 space-y-2">
                <p className="text-foreground">
                  {scheduleProblem === "holiday" || selectedDoctor
                    ? t(`schedule_${scheduleProblem}`, { doctor: selectedDoctor?.name ?? "" })
                    : t(`schedule_${scheduleProblem}_business`)}
                </p>
                <button
                  type="button"
                  onClick={() => handleSave(true)}
                  disabled={saving}
                  className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {t("saveAnyway")}
                </button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          {booking ? (
            confirmDelete ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">{t("confirmDelete")}</span>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                >
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? t("deleting") : t("delete")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
              >
                <Trash2 className="h-3 w-3" />
                {t("delete")}
              </button>
            )
          ) : (
            <span />
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => handleSave()}
              disabled={saving || !contactId || !date || !startTime || !endTime}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
