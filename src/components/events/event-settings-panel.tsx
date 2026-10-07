"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { EventSettings } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { KNOWN_ERRORS, sendJson } from "./event-utils";
import { defaultWeeklyHours, WeeklyHoursEditor, type WeeklyHours } from "./weekly-hours-editor";

interface Props {
  settings: EventSettings;
  onSaved: (settings: EventSettings) => void;
}

/** Each business decides how its event requests work: approval, deposit
 *  and its percentage, notice, payment instructions and event types. */
export function EventSettingsPanel({ settings, onSaved }: Props) {
  const t = useTranslations("Events");
  const [draft, setDraft] = useState<EventSettings>(settings);
  const [typesText, setTypesText] = useState(settings.event_types.join(", "));
  const [ownHours, setOwnHours] = useState(!!settings.hours);
  const [hours, setHours] = useState<WeeklyHours>(settings.hours ?? defaultWeeklyHours());
  const [saving, setSaving] = useState(false);

  const patch = (p: Partial<EventSettings>) => setDraft((d) => ({ ...d, ...p }));

  async function save() {
    setSaving(true);
    const body: EventSettings = {
      ...draft,
      event_types: typesText.split(",").map((s) => s.trim()).filter(Boolean),
      hours: ownHours ? hours : null,
    };
    const res = await sendJson<{ settings: EventSettings }>("/api/events/settings", "PUT", body);
    setSaving(false);
    if (!res.ok) {
      toast.error(KNOWN_ERRORS.has(res.code) ? t(`errors.${res.code}`) : t("errors.failed"));
      return;
    }
    toast.success(t("settings.saved"));
    setDraft(res.data.settings);
    setTypesText(res.data.settings.event_types.join(", "));
    onSaved(res.data.settings);
  }

  const row = "flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-3";

  return (
    <div className="max-w-2xl space-y-3">
      <div className={row}>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t("settings.approval")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.approvalHelp")}</p>
        </div>
        <Switch checked={draft.requires_approval} onCheckedChange={(v) => patch({ requires_approval: v })} />
      </div>

      <div className={`${row} flex-col sm:flex-row`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{t("settings.deposit")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.depositHelp")}</p>
          {draft.deposit_required && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Label className="text-xs text-muted-foreground">{t("settings.depositPercent")}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={draft.deposit_percent}
                onChange={(e) => patch({ deposit_percent: Number(e.target.value) })}
                className="h-8 w-24 border-border bg-background text-sm"
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          )}
        </div>
        <Switch checked={draft.deposit_required} onCheckedChange={(v) => patch({ deposit_required: v })} />
      </div>

      {draft.deposit_required && (
        <div className="space-y-1 rounded-lg border border-border bg-card p-3">
          <Label className="text-sm font-medium text-foreground">{t("settings.instructions")}</Label>
          <p className="text-xs text-muted-foreground">{t("settings.instructionsHelp")}</p>
          <Textarea
            rows={3}
            value={draft.deposit_instructions}
            onChange={(e) => patch({ deposit_instructions: e.target.value })}
            placeholder={t("settings.instructionsPlaceholder")}
            className="border-border bg-background text-sm"
          />
        </div>
      )}

      <div className="grid gap-3 rounded-lg border border-border bg-card p-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-sm font-medium text-foreground">{t("settings.currency")}</Label>
          <Input
            value={draft.currency}
            maxLength={3}
            onChange={(e) => patch({ currency: e.target.value.toUpperCase() })}
            className="h-9 border-border bg-background text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-sm font-medium text-foreground">{t("settings.minNotice")}</Label>
          <Input
            type="number"
            min={0}
            value={draft.min_notice_days}
            onChange={(e) => patch({ min_notice_days: Number(e.target.value) })}
            className="h-9 border-border bg-background text-sm"
          />
          <p className="text-xs text-muted-foreground">{t("settings.minNoticeHelp")}</p>
        </div>
      </div>

      <div className="space-y-1 rounded-lg border border-border bg-card p-3">
        <Label className="text-sm font-medium text-foreground">{t("settings.types")}</Label>
        <p className="text-xs text-muted-foreground">{t("settings.typesHelp")}</p>
        <Input value={typesText} onChange={(e) => setTypesText(e.target.value)} className="h-9 border-border bg-background text-sm" />
        <div className="flex flex-wrap gap-1 pt-1">
          {typesText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => (
              <span key={s} className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                {s}
              </span>
            ))}
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-card p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t("settings.ownHours")}</p>
            <p className="text-xs text-muted-foreground">{t("settings.ownHoursHelp")}</p>
          </div>
          <Switch checked={ownHours} onCheckedChange={setOwnHours} />
        </div>
        {ownHours && <WeeklyHoursEditor value={hours} onChange={setHours} />}
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90">
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}
