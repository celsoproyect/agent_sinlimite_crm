"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Stethoscope, Trash2 } from "lucide-react";
import type {
  BookingSettings,
  ClinicServiceRow,
  ClinicSettings,
  Professional,
  ProfessionalTimeOff,
  Specialty,
} from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ClinicInsurancePanel, ClinicServicesPanel, ClinicTimeOffSection } from "./clinic-extra-panels";
import { SampleDataBar } from "@/components/samples/sample-data-bar";

type Tab = "doctors" | "specialties" | "services" | "insurance";
const TABS: Tab[] = ["doctors", "specialties", "services", "insurance"];
const TAB_LABEL: Record<Tab, string> = {
  doctors: "tabDoctors",
  specialties: "tabSpecialties",
  services: "tabServices",
  insurance: "tabInsurance",
};

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

interface DayState {
  open: boolean;
  openTime: string;
  closeTime: string;
}

type DaysState = Record<Weekday, DayState>;

function daysFrom(hours: BookingSettings["hours"] | null | undefined): DaysState {
  const result = {} as DaysState;
  for (const day of WEEKDAYS) {
    const h = hours?.[day];
    result[day] = h
      ? { open: true, openTime: h.open, closeTime: h.close }
      : { open: !hours && day !== "saturday" && day !== "sunday", openTime: "08:00", closeTime: "17:00" };
  }
  return result;
}

function hoursFrom(days: DaysState): BookingSettings["hours"] {
  const hours: BookingSettings["hours"] = {};
  for (const day of WEEKDAYS) {
    hours[day] = days[day].open ? { open: days[day].openTime, close: days[day].closeTime } : null;
  }
  return hours;
}

interface DoctorDraft {
  id: string | null;
  name: string;
  bio: string;
  active: boolean;
  specialtyIds: string[];
  slotMinutes: string;
  ownHours: boolean;
  days: DaysState;
}

function draftFrom(p: Professional | null): DoctorDraft {
  return {
    id: p?.id ?? null,
    name: p?.name ?? "",
    bio: p?.bio ?? "",
    active: p?.active ?? true,
    specialtyIds: p?.specialty_ids ?? [],
    slotMinutes: p?.slot_minutes ? String(p.slot_minutes) : "",
    ownHours: !!p?.hours,
    days: daysFrom(p?.hours),
  };
}

interface ClinicDirectoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  migrated: boolean;
  professionals: Professional[];
  specialties: Specialty[];
  /** Migration 067 has run: services, days off and insurance. */
  extended: boolean;
  services: ClinicServiceRow[];
  timeOff: ProfessionalTimeOff[];
  settings: ClinicSettings;
  onChanged: () => Promise<void> | void;
  /** After example data is loaded or removed (the agenda reloads its bookings too). */
  onSamplesChanged?: () => Promise<void> | void;
}

/** Clinic module: manage the doctors (with their specialties, own hours
 *  and appointment length) and the specialty list. */
export function ClinicDirectoryDialog({
  open,
  onOpenChange,
  migrated,
  professionals,
  specialties,
  extended,
  services,
  timeOff,
  settings,
  onChanged,
  onSamplesChanged,
}: ClinicDirectoryDialogProps) {
  const t = useTranslations("Agenda.clinic");
  const tDays = useTranslations("Agenda.businessHours");
  const [tab, setTab] = useState<Tab>("doctors");
  const [draft, setDraft] = useState<DoctorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [newSpecialty, setNewSpecialty] = useState("");
  const [editingSpecialty, setEditingSpecialty] = useState<{ id: string; name: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Reset to the list every time the dialog opens.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setEditingSpecialty(null);
    setConfirmDeleteId(null);
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const specialtyName = (id: string) => specialties.find((s) => s.id === id)?.name ?? "";

  async function request(url: string, method: string, body?: unknown): Promise<boolean> {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return true;
    const json = await res.json().catch(() => ({}));
    const code = typeof json.error === "string" ? json.error : "";
    if (code === "duplicate_name") toast.error(t("duplicateName"));
    else if (code === "invalid_hours") toast.error(t("invalidHours"));
    else if (code === "invalid_slot_minutes") toast.error(t("invalidSlotMinutes"));
    else if (code === "invalid_duration") toast.error(t("invalidDuration"));
    else if (code === "invalid_price") toast.error(t("invalidPrice"));
    else if (code === "invalid_dates") toast.error(t("invalidDates"));
    else if (code === "clinic_not_migrated") toast.error(t("notMigrated"));
    else toast.error(t("toastFailed"));
    return false;
  }

  async function saveDoctor() {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error(t("nameRequired"));
      return;
    }
    setSaving(true);
    const body = {
      name: draft.name.trim(),
      bio: draft.bio.trim() || null,
      active: draft.active,
      specialty_ids: draft.specialtyIds,
      slot_minutes: draft.slotMinutes.trim() ? Number(draft.slotMinutes) : null,
      hours: draft.ownHours ? hoursFrom(draft.days) : null,
    };
    const ok = await request(
      draft.id ? `/api/clinic/professionals/${draft.id}` : "/api/clinic/professionals",
      draft.id ? "PATCH" : "POST",
      body,
    );
    setSaving(false);
    if (!ok) return;
    toast.success(t("toastSaved"));
    setDraft(null);
    await onChanged();
  }

  async function deleteDoctor(id: string) {
    if (!(await request(`/api/clinic/professionals/${id}`, "DELETE"))) return;
    toast.success(t("toastDeleted"));
    setConfirmDeleteId(null);
    await onChanged();
  }

  async function addSpecialty() {
    const name = newSpecialty.trim();
    if (!name) return;
    if (!(await request("/api/clinic/specialties", "POST", { name }))) return;
    setNewSpecialty("");
    await onChanged();
  }

  async function renameSpecialty() {
    if (!editingSpecialty?.name.trim()) return;
    const ok = await request(`/api/clinic/specialties/${editingSpecialty.id}`, "PATCH", {
      name: editingSpecialty.name.trim(),
    });
    if (!ok) return;
    setEditingSpecialty(null);
    await onChanged();
  }

  async function deleteSpecialty(id: string) {
    if (!(await request(`/api/clinic/specialties/${id}`, "DELETE"))) return;
    setConfirmDeleteId(null);
    await onChanged();
  }

  const setDay = (day: Weekday, patch: Partial<DayState>) =>
    setDraft((d) => (d ? { ...d, days: { ...d.days, [day]: { ...d.days[day], ...patch } } } : d));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <Stethoscope className="h-4 w-4 text-primary" />
            {t("title")}
          </DialogTitle>
        </DialogHeader>

        {migrated && !draft && (
          <SampleDataBar
            module="clinic"
            hasSamples={professionals.some((p) => p.is_sample)}
            onChanged={async () => {
              await onChanged();
              await onSamplesChanged?.();
            }}
          />
        )}

        {!migrated ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
            {t("notMigrated")}
          </p>
        ) : draft ? (
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("name")}</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("namePlaceholder")}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("specialties")}</Label>
              {specialties.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noSpecialtiesYet")}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {specialties.map((s) => {
                    const on = draft.specialtyIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            specialtyIds: on
                              ? draft.specialtyIds.filter((id) => id !== s.id)
                              : [...draft.specialtyIds, s.id],
                          })
                        }
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("bio")}</Label>
              <Textarea
                value={draft.bio}
                onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                placeholder={t("bioPlaceholder")}
                className="min-h-[60px] border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("slotMinutes")}</Label>
                <Input
                  type="number"
                  min={5}
                  max={480}
                  value={draft.slotMinutes}
                  onChange={(e) => setDraft({ ...draft, slotMinutes: e.target.value })}
                  placeholder={t("slotMinutesPlaceholder")}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                <span className="text-sm text-foreground">{t("active")}</span>
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
              </label>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              <label className="flex items-center justify-between gap-3">
                <span className="text-sm text-foreground">{t("ownHours")}</span>
                <Switch checked={draft.ownHours} onCheckedChange={(v) => setDraft({ ...draft, ownHours: v })} />
              </label>
              <p className="text-xs text-muted-foreground">{t("ownHoursHint")}</p>
              {draft.ownHours && (
                <div className="space-y-1.5 pt-1">
                  {WEEKDAYS.map((day) => (
                    <div key={day} className="flex flex-wrap items-center gap-2">
                      <Switch
                        checked={draft.days[day].open}
                        onCheckedChange={(v) => setDay(day, { open: v })}
                      />
                      <span className="w-24 text-sm text-foreground">{tDays(day)}</span>
                      {draft.days[day].open ? (
                        <>
                          <Input
                            type="time"
                            value={draft.days[day].openTime}
                            onChange={(e) => setDay(day, { openTime: e.target.value })}
                            className="h-8 w-28 border-border bg-muted text-foreground"
                          />
                          <span className="text-muted-foreground">–</span>
                          <Input
                            type="time"
                            value={draft.days[day].closeTime}
                            onChange={(e) => setDay(day, { closeTime: e.target.value })}
                            className="h-8 w-28 border-border bg-muted text-foreground"
                          />
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">{tDays("closed")}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {draft.id &&
              (extended ? (
                <ClinicTimeOffSection
                  professionalId={draft.id}
                  timeOff={timeOff}
                  request={request}
                  onChanged={onChanged}
                />
              ) : (
                <p className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
                  {t("notMigrated067")}
                </p>
              ))}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setDraft(null)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={saveDoctor}
                disabled={saving || !draft.name.trim()}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? t("saving") : t("save")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
              {TABS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setTab(v)}
                  className={cn(
                    "min-h-9 flex-1 rounded px-2 py-1 text-xs font-medium sm:min-h-0",
                    tab === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(TAB_LABEL[v])}
                </button>
              ))}
            </div>

            {tab === "doctors" ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">{t("doctorsHint")}</p>
                <Button
                  onClick={() => setDraft(draftFrom(null))}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Plus className="mr-1 h-4 w-4" />
                  {t("addDoctor")}
                </Button>
                {professionals.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t("noDoctors")}</p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {professionals.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className={cn("text-sm font-medium text-foreground", !p.active && "opacity-60")}>
                            {p.name}
                            {!p.active && (
                              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                {t("inactive")}
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {p.specialty_ids.map(specialtyName).filter(Boolean).join(", ") || t("noSpecialty")}
                            {" · "}
                            {p.hours ? t("hoursCustom") : t("hoursBusiness")}
                            {p.slot_minutes ? ` · ${t("minutes", { count: p.slot_minutes })}` : ""}
                          </p>
                        </div>
                        {confirmDeleteId === p.id ? (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-muted-foreground">{t("confirmDeleteDoctor")}</span>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="min-h-9 rounded px-2 py-1 sm:min-h-0 text-muted-foreground hover:bg-muted"
                            >
                              {t("cancel")}
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteDoctor(p.id)}
                              className="min-h-9 rounded bg-red-600 px-2 py-1 sm:min-h-0 font-medium text-white hover:bg-red-700"
                            >
                              {t("delete")}
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => setDraft(draftFrom(p))}
                              className="inline-flex size-10 items-center justify-center rounded sm:size-8 text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label={t("edit")}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(p.id)}
                              className="inline-flex size-10 items-center justify-center rounded sm:size-8 text-red-400 hover:bg-muted hover:text-red-300"
                              aria-label={t("delete")}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : tab === "services" || tab === "insurance" ? (
              !extended ? (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
                  {t("notMigrated067")}
                </p>
              ) : tab === "services" ? (
                <ClinicServicesPanel
                  services={services}
                  specialties={specialties}
                  request={request}
                  onChanged={onChanged}
                />
              ) : (
                <ClinicInsurancePanel settings={settings} request={request} onChanged={onChanged} />
              )
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={newSpecialty}
                    onChange={(e) => setNewSpecialty(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addSpecialty();
                    }}
                    placeholder={t("specialtyPlaceholder")}
                    className="border-border bg-muted text-foreground"
                  />
                  <Button
                    onClick={addSpecialty}
                    disabled={!newSpecialty.trim()}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    {t("add")}
                  </Button>
                </div>
                {specialties.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t("noSpecialties")}</p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {specialties.map((s) => {
                      const count = professionals.filter((p) => p.specialty_ids.includes(s.id)).length;
                      return (
                        <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                          {editingSpecialty?.id === s.id ? (
                            <>
                              <Input
                                value={editingSpecialty.name}
                                onChange={(e) => setEditingSpecialty({ id: s.id, name: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void renameSpecialty();
                                }}
                                className="h-8 flex-1 border-border bg-muted text-foreground"
                              />
                              <Button size="sm" onClick={renameSpecialty}>
                                {t("save")}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setEditingSpecialty(null)}>
                                {t("cancel")}
                              </Button>
                            </>
                          ) : (
                            <>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-foreground">{s.name}</p>
                                <p className="text-xs text-muted-foreground">{t("doctorCount", { count })}</p>
                              </div>
                              {confirmDeleteId === s.id ? (
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="text-muted-foreground">{t("confirmDeleteSpecialty")}</span>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    className="min-h-9 rounded px-2 py-1 sm:min-h-0 text-muted-foreground hover:bg-muted"
                                  >
                                    {t("cancel")}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => deleteSpecialty(s.id)}
                                    className="min-h-9 rounded bg-red-600 px-2 py-1 sm:min-h-0 font-medium text-white hover:bg-red-700"
                                  >
                                    {t("delete")}
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => setEditingSpecialty({ id: s.id, name: s.name })}
                                    className="inline-flex size-10 items-center justify-center rounded sm:size-8 text-muted-foreground hover:bg-muted hover:text-foreground"
                                    aria-label={t("edit")}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(s.id)}
                                    className="inline-flex size-10 items-center justify-center rounded sm:size-8 text-red-400 hover:bg-muted hover:text-red-300"
                                    aria-label={t("delete")}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
