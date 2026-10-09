"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarOff, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ClinicServiceRow, ClinicSettings, ProfessionalTimeOff, Specialty } from "@/types";
import { businessToday } from "@/lib/business-timezone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// Clinic module, migration 067: the Servicios and Seguros tabs of the
// doctors dialog and the Ausencias block of the doctor form. `request`
// is the dialog's fetch helper (it shows the error toasts).

type Request = (url: string, method: string, body?: unknown) => Promise<boolean>;

const selectClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

/** "2026-10-12" → "12/10/2026". */
function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

interface ServiceDraft {
  id: string | null;
  name: string;
  description: string;
  specialtyId: string;
  duration: string;
  price: string;
  active: boolean;
}

function serviceDraft(s: ClinicServiceRow | null): ServiceDraft {
  return {
    id: s?.id ?? null,
    name: s?.name ?? "",
    description: s?.description ?? "",
    specialtyId: s?.specialty_id ?? "",
    duration: s ? String(s.duration_minutes) : "30",
    price: s?.price === null || s?.price === undefined ? "" : String(s.price),
    active: s?.active ?? true,
  };
}

export function ClinicServicesPanel({
  services,
  specialties,
  request,
  onChanged,
}: {
  services: ClinicServiceRow[];
  specialties: Specialty[];
  request: Request;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations("Agenda.clinic");
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const specialtyName = (id: string | null | undefined) =>
    (id && specialties.find((s) => s.id === id)?.name) || t("anyDoctor");

  async function save() {
    if (!draft) return;
    setSaving(true);
    const ok = await request(
      draft.id ? `/api/clinic/services/${draft.id}` : "/api/clinic/services",
      draft.id ? "PATCH" : "POST",
      {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        specialty_id: draft.specialtyId || null,
        duration_minutes: Number(draft.duration),
        price: draft.price.trim() ? Number(draft.price) : null,
        active: draft.active,
      },
    );
    setSaving(false);
    if (!ok) return;
    setDraft(null);
    await onChanged();
  }

  async function remove(id: string) {
    if (!(await request(`/api/clinic/services/${id}`, "DELETE"))) return;
    setConfirmDeleteId(null);
    await onChanged();
  }

  if (draft) {
    return (
      <div className="space-y-4">
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("name")}</Label>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={t("servicePlaceholder")}
            className="border-border bg-muted text-foreground"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-2 sm:col-span-1">
            <Label className="text-muted-foreground">{t("serviceDuration")}</Label>
            <Input
              type="number"
              min={5}
              max={480}
              value={draft.duration}
              onChange={(e) => setDraft({ ...draft, duration: e.target.value })}
              className="border-border bg-muted text-foreground"
            />
          </div>
          <div className="grid gap-2 sm:col-span-1">
            <Label className="text-muted-foreground">{t("servicePrice")}</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={draft.price}
              onChange={(e) => setDraft({ ...draft, price: e.target.value })}
              placeholder={t("servicePricePlaceholder")}
              className="border-border bg-muted text-foreground"
            />
          </div>
          <div className="grid gap-2 sm:col-span-1">
            <Label className="text-muted-foreground">{t("serviceSpecialty")}</Label>
            <select
              value={draft.specialtyId}
              onChange={(e) => setDraft({ ...draft, specialtyId: e.target.value })}
              className={selectClass}
            >
              <option value="">{t("anyDoctor")}</option>
              {specialties.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("bio")}</Label>
          <Textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder={t("serviceDescriptionPlaceholder")}
            className="min-h-[60px] border-border bg-muted text-foreground"
          />
        </div>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
          <span className="text-sm text-foreground">{t("serviceActive")}</span>
          <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
        </label>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => setDraft(null)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={save}
            disabled={saving || !draft.name.trim() || !draft.duration.trim()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("servicesHint")}</p>
      <Button
        onClick={() => setDraft(serviceDraft(null))}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
      >
        <Plus className="mr-1 h-4 w-4" />
        {t("addService")}
      </Button>
      {services.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("noServices")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {services.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm font-medium text-foreground", !s.active && "opacity-60")}>
                  {s.name}
                  {!s.active && (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t("inactive")}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("minutes", { count: s.duration_minutes })}
                  {" · "}
                  {specialtyName(s.specialty_id)}
                  {s.price !== null && s.price !== undefined
                    ? ` · RD$${Number(s.price).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                    : ""}
                </p>
              </div>
              {confirmDeleteId === s.id ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{t("confirmDeleteService")}</span>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(null)}
                    className="min-h-9 rounded px-2 py-1 sm:min-h-0 text-muted-foreground hover:bg-muted"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(s.id)}
                    className="min-h-9 rounded bg-red-600 px-2 py-1 sm:min-h-0 font-medium text-white hover:bg-red-700"
                  >
                    {t("delete")}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDraft(serviceDraft(s))}
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ClinicInsurancePanel({
  settings,
  request,
  onChanged,
}: {
  settings: ClinicSettings;
  request: Request;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations("Agenda.clinic");
  const [ask, setAsk] = useState(settings.ask_insurance);
  const [insurers, setInsurers] = useState<string[]>(settings.insurers);
  const [newInsurer, setNewInsurer] = useState("");
  const [saving, setSaving] = useState(false);

  function addInsurer() {
    const name = newInsurer.trim();
    if (!name) return;
    if (!insurers.some((i) => i.toLowerCase() === name.toLowerCase())) setInsurers([...insurers, name]);
    setNewInsurer("");
  }

  async function save() {
    setSaving(true);
    const ok = await request("/api/clinic/settings", "PATCH", { ask_insurance: ask, insurers });
    setSaving(false);
    if (!ok) return;
    await onChanged();
  }

  const dirty =
    ask !== settings.ask_insurance || insurers.join("\u0000") !== settings.insurers.join("\u0000");

  return (
    <div className="space-y-4">
      <label className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-sm text-foreground">{t("askInsurance")}</span>
          <span className="block text-xs text-muted-foreground">{t("askInsuranceHint")}</span>
        </span>
        <Switch checked={ask} onCheckedChange={setAsk} />
      </label>

      <div className="space-y-2">
        <Label className="text-muted-foreground">{t("insurers")}</Label>
        <p className="text-xs text-muted-foreground">{t("insurersHint")}</p>
        <div className="flex gap-2">
          <Input
            value={newInsurer}
            onChange={(e) => setNewInsurer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addInsurer();
            }}
            placeholder={t("insurerPlaceholder")}
            className="border-border bg-muted text-foreground"
          />
          <Button
            variant="outline"
            onClick={addInsurer}
            disabled={!newInsurer.trim()}
            className="border-border"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("add")}
          </Button>
        </div>
        {insurers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noInsurers")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {insurers.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground"
              >
                {name}
                <button
                  type="button"
                  onClick={() => setInsurers(insurers.filter((i) => i !== name))}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={t("delete")}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          onClick={save}
          disabled={saving || !dirty}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  );
}

export function ClinicTimeOffSection({
  professionalId,
  timeOff,
  request,
  onChanged,
}: {
  professionalId: string;
  timeOff: ProfessionalTimeOff[];
  request: Request;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations("Agenda.clinic");
  const [from, setFrom] = useState(() => businessToday());
  const [to, setTo] = useState(() => businessToday());
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const mine = timeOff.filter((r) => r.professional_id === professionalId);

  async function add() {
    setSaving(true);
    const ok = await request(`/api/clinic/professionals/${professionalId}/time-off`, "POST", {
      starts_on: from,
      ends_on: to < from ? from : to,
      reason: reason.trim() || null,
    });
    setSaving(false);
    if (!ok) return;
    setReason("");
    await onChanged();
  }

  async function remove(id: string) {
    if (!(await request(`/api/clinic/time-off/${id}`, "DELETE"))) return;
    await onChanged();
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <CalendarOff className="h-4 w-4 text-muted-foreground" />
        {t("timeOff")}
      </p>
      <p className="text-xs text-muted-foreground">{t("timeOffHint")}</p>
      {mine.length > 0 && (
        <ul className="space-y-1">
          {mine.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 text-foreground">
                {r.starts_on === r.ends_on
                  ? formatDay(r.starts_on)
                  : t("timeOffRange", { from: formatDay(r.starts_on), to: formatDay(r.ends_on) })}
                {r.reason ? <span className="text-muted-foreground"> · {r.reason}</span> : null}
              </span>
              <button
                type="button"
                onClick={() => remove(r.id)}
                className="inline-flex size-10 items-center justify-center rounded sm:size-8 text-red-400 hover:bg-muted hover:text-red-300"
                aria-label={t("delete")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">{t("timeOffFrom")}</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-10 border-border bg-muted text-foreground sm:h-8"
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">{t("timeOffTo")}</Label>
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="h-10 border-border bg-muted text-foreground sm:h-8"
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">{t("timeOffReason")}</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("timeOffReasonPlaceholder")}
            className="h-10 border-border bg-muted text-foreground sm:h-8"
          />
        </div>
        <Button size="sm" onClick={add} disabled={saving || !from} className="h-10 bg-primary text-primary-foreground sm:h-7">
          <Plus className="mr-1 h-4 w-4" />
          {t("add")}
        </Button>
      </div>
    </div>
  );
}
