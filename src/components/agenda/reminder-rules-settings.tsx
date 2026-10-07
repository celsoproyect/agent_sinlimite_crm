"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { BookingKind, BookingReminderRule, MessageTemplate, ReminderAppliesTo, ReminderRuleKind } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Loader2, Sparkles, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface ReminderRulesSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which bookings this dialog manages (migration 068): the agenda's
   *  appointments, restaurant tables or events. Rules that apply to every
   *  booking show up in all three. */
  scope?: BookingKind;
}

type OffsetUnit = "minutes" | "hours" | "days";

interface RuleRow {
  id: string | null; // null = not yet saved
  kind: ReminderRuleKind;
  appliesTo: ReminderAppliesTo;
  offsetValue: number;
  offsetUnit: OffsetUnit;
  messageText: string;
  templateName: string | null;
  templateLanguage: string | null;
  enabled: boolean;
  isSample: boolean;
  /** The saved rule already has the 068 columns, so a PATCH can send them. */
  extended: boolean;
  saving: boolean;
}

const UNIT_MINUTES: Record<OffsetUnit, number> = { minutes: 1, hours: 60, days: 1440 };

function minutesToRow(minutes: number): { offsetValue: number; offsetUnit: OffsetUnit } {
  if (minutes % 1440 === 0) return { offsetValue: minutes / 1440, offsetUnit: "days" };
  if (minutes % 60 === 0) return { offsetValue: minutes / 60, offsetUnit: "hours" };
  return { offsetValue: minutes, offsetUnit: "minutes" };
}

function ruleToRow(rule: BookingReminderRule): RuleRow {
  return {
    id: rule.id,
    kind: rule.kind ?? "before",
    appliesTo: rule.applies_to ?? "all",
    ...minutesToRow(rule.offset_minutes),
    messageText: rule.message_text,
    templateName: rule.template_name ?? null,
    templateLanguage: rule.template_language ?? null,
    enabled: rule.enabled,
    isSample: !!rule.is_sample,
    extended: rule.kind !== undefined,
    saving: false,
  };
}

function emptyRow(scope: BookingKind, kind: ReminderRuleKind = "before", offsetValue = 24, offsetUnit: OffsetUnit = "hours"): RuleRow {
  return {
    id: null,
    kind,
    // The agenda's rules keep applying to every booking, as before.
    appliesTo: scope === "appointment" ? "all" : scope,
    offsetValue,
    offsetUnit,
    messageText: "",
    templateName: null,
    templateLanguage: null,
    enabled: true,
    isSample: false,
    extended: false,
    saving: false,
  };
}

/** Tokens offered for each kind of booking. */
const TOKENS: Record<BookingKind, string[]> = {
  appointment: ["contact_name", "service", "date", "time", "reference", "doctor"],
  table: ["contact_name", "date", "time", "reference", "party_size", "tables"],
  event: ["contact_name", "service", "date", "time", "reference", "party_size", "hall", "deposit"],
};

export function ReminderRulesSettings({ open, onOpenChange, scope = "appointment" }: ReminderRulesSettingsProps) {
  const t = useTranslations("Agenda.reminders");
  const supabase = createClient();

  const [rows, setRows] = useState<RuleRow[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [samplesBusy, setSamplesBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [rulesRes, templatesRes] = await Promise.all([
      fetch("/api/bookings/reminder-rules"),
      supabase
        .from("message_templates")
        .select("*")
        .eq("status", "APPROVED")
        .order("created_at", { ascending: false }),
    ]);
    let loaded: BookingReminderRule[] = [];
    if (rulesRes.ok) {
      const json = await rulesRes.json();
      loaded = ((json.rules ?? []) as BookingReminderRule[]).filter(
        (r) => (r.applies_to ?? "all") === "all" || r.applies_to === scope,
      );
    }
    // Reminders first (furthest ahead first), then follow-ups.
    loaded.sort((a, b) => {
      const ka = a.kind === "after" ? 1 : 0;
      const kb = b.kind === "after" ? 1 : 0;
      if (ka !== kb) return ka - kb;
      return ka === 0 ? b.offset_minutes - a.offset_minutes : a.offset_minutes - b.offset_minutes;
    });
    setRows(loaded.length > 0 ? loaded.map(ruleToRow) : [emptyRow(scope), emptyRow(scope, "before", 2, "hours")]);
    setTemplates((templatesRes.data as MessageTemplate[]) ?? []);
    setLoading(false);
  }, [scope, supabase]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads when the dialog opens
    void load();
  }, [open, load]);

  function updateRow(index: number, patch: Partial<RuleRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRow(kind: ReminderRuleKind) {
    setRows((prev) => [...prev, kind === "after" ? emptyRow(scope, "after", 1, "days") : emptyRow(scope, "before", 60, "minutes")]);
  }

  async function removeRow(index: number) {
    const row = rows[index];
    if (!row.id) {
      setRows((prev) => prev.filter((_, i) => i !== index));
      return;
    }
    if (!confirm(t("confirmDelete"))) return;
    updateRow(index, { saving: true });
    const res = await fetch(`/api/bookings/reminder-rules/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(t("toastFailedDelete"));
      updateRow(index, { saving: false });
      return;
    }
    setRows((prev) => prev.filter((_, i) => i !== index));
    toast.success(t("toastDeleted"));
  }

  /** Save the row; `adopt` also turns an example into a real rule. */
  async function saveRow(index: number, adopt = false) {
    const row = rows[index];
    if (!row.messageText.trim()) {
      toast.error(t("validationMessageRequired"));
      return;
    }
    const offsetMinutes = row.offsetValue * UNIT_MINUTES[row.offsetUnit];
    if (!Number.isFinite(offsetMinutes) || offsetMinutes <= 0) {
      toast.error(t("validationOffsetRequired"));
      return;
    }

    updateRow(index, { saving: true });
    const payload: Record<string, unknown> = {
      offset_minutes: offsetMinutes,
      message_text: row.messageText,
      template_name: row.templateName,
      template_language: row.templateLanguage,
      enabled: row.enabled,
    };
    // Only sent when they differ from the pre-068 defaults, so the agenda
    // keeps working before the migration.
    if (row.kind !== "before" || row.extended) payload.kind = row.kind;
    if (row.appliesTo !== "all" || row.extended) payload.applies_to = row.appliesTo;
    if (adopt) payload.is_sample = false;

    const res = row.id
      ? await fetch(`/api/bookings/reminder-rules/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      : await fetch("/api/bookings/reminder-rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

    if (!res.ok) {
      const json = await res.json().catch(() => null);
      toast.error(
        json?.code === "needs_migration"
          ? t("needsMigration")
          : json?.code === "duplicate_rule"
            ? t("duplicateRule")
            : (json?.error ?? t("toastFailedSave")),
      );
      updateRow(index, { saving: false });
      return;
    }
    const json = await res.json();
    const saved = json.rule as BookingReminderRule;
    updateRow(index, { ...ruleToRow(saved) });
    toast.success(adopt ? t("toastAdopted") : t("toastSaved"));
  }

  async function samples(method: "POST" | "DELETE") {
    if (method === "DELETE" && !confirm(t("confirmRemoveSamples"))) return;
    setSamplesBusy(true);
    const res = await fetch("/api/samples", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ module: "reminders", scope }),
    }).catch(() => null);
    setSamplesBusy(false);
    if (!res?.ok) {
      const json = await res?.json().catch(() => null);
      toast.error(json?.code === "needs_migration" ? t("needsMigration") : t("samplesFailed"));
      return;
    }
    toast.success(method === "POST" ? t("samplesLoaded") : t("samplesRemoved"));
    await load();
  }

  function pickTemplate(index: number, name: string | null) {
    const template = templates.find((tpl) => tpl.name === name) ?? null;
    updateRow(index, {
      templateName: template?.name ?? null,
      templateLanguage: template?.language ?? null,
    });
  }

  const hasSamples = rows.some((r) => r.isSample);
  const tokenHelp = TOKENS[scope].map((k) => `{{${k}}}`).join(", ");
  const itemClass = "text-popover-foreground focus:bg-muted focus:text-popover-foreground";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t(`scopeTitle.${scope}`)}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t("descriptionFollowUp")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-2">
              <Sparkles className="h-4 w-4 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("samplesHint")}</p>
              <Button size="sm" variant="outline" disabled={samplesBusy} onClick={() => samples("POST")} className="border-border">
                {t("loadSamples")}
              </Button>
              {hasSamples && (
                <Button size="sm" variant="ghost" disabled={samplesBusy} onClick={() => samples("DELETE")} className="text-muted-foreground">
                  {t("removeSamples")}
                </Button>
              )}
            </div>

            {rows.map((row, index) => (
              <div
                key={row.id ?? `new-${index}`}
                className={
                  row.isSample
                    ? "space-y-3 rounded-lg border border-dashed border-primary/50 bg-primary/5 p-3"
                    : "space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3"
                }
              >
                {row.isSample && (
                  <p className="text-[0.6875rem] font-medium text-primary">{t("sampleBadge")}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={row.kind}
                    onValueChange={(val) => val && updateRow(index, { kind: val as ReminderRuleKind })}
                  >
                    <SelectTrigger className="h-8 w-auto min-w-36 border-border bg-background text-xs text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem value="before" className={itemClass}>{t("kindBefore")}</SelectItem>
                      <SelectItem value="after" className={itemClass}>{t("kindAfter")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min={1}
                    value={row.offsetValue}
                    onChange={(e) => updateRow(index, { offsetValue: Number(e.target.value) || 0 })}
                    className="h-8 w-20 border-border bg-background text-xs text-foreground"
                  />
                  <Select
                    value={row.offsetUnit}
                    onValueChange={(val) => val && updateRow(index, { offsetUnit: val as OffsetUnit })}
                  >
                    <SelectTrigger className="h-8 w-auto min-w-24 border-border bg-background text-xs text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem value="minutes" className={itemClass}>{t("unitMinutes")}</SelectItem>
                      <SelectItem value="hours" className={itemClass}>{t("unitHours")}</SelectItem>
                      <SelectItem value="days" className={itemClass}>{t("unitDays")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {row.kind === "after" ? t(`afterScope.${scope}`) : t(`beforeScope.${scope}`)}
                  </span>

                  <div className="ml-auto flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {row.enabled ? t("enabled") : t("disabled")}
                    </span>
                    <Switch
                      checked={row.enabled}
                      onCheckedChange={(checked) => updateRow(index, { enabled: checked })}
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(index)}
                      disabled={row.saving}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                      aria-label={t("delete")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Label className="text-xs text-muted-foreground shrink-0">{t("appliesTo")}</Label>
                  <Select
                    value={row.appliesTo}
                    onValueChange={(val) => val && updateRow(index, { appliesTo: val as ReminderAppliesTo })}
                  >
                    <SelectTrigger className="h-8 w-auto min-w-40 border-border bg-background text-xs text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem value="all" className={itemClass}>{t("appliesAll")}</SelectItem>
                      <SelectItem value={scope} className={itemClass}>{t(`appliesOnly.${scope}`)}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Textarea
                    value={row.messageText}
                    onChange={(e) => updateRow(index, { messageText: e.target.value })}
                    placeholder={row.kind === "after" ? t.raw("followUpPlaceholder") : t.raw("messagePlaceholder")}
                    rows={3}
                    className="border-border bg-background text-xs text-foreground"
                  />
                  <p className="text-[0.625rem] text-muted-foreground">
                    {t("tokensLabel")} {tokenHelp}
                  </p>
                  {row.kind === "after" && (
                    <p className="text-[0.625rem] text-muted-foreground">{t("followUpHint")}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Label className="text-xs text-muted-foreground shrink-0">{t("fallbackTemplate")}</Label>
                  <Select
                    value={row.templateName ?? undefined}
                    onValueChange={(val) => pickTemplate(index, val || null)}
                  >
                    <SelectTrigger className="h-8 min-w-40 flex-1 border-border bg-background text-xs text-foreground">
                      <SelectValue placeholder={t("noTemplate")} />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      {templates.map((tpl) => (
                        <SelectItem key={tpl.id} value={tpl.name} className={itemClass}>
                          {tpl.name} {tpl.language ? `(${tpl.language})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {row.templateName && (
                    <button
                      type="button"
                      onClick={() => pickTemplate(index, null)}
                      className="text-[0.625rem] text-muted-foreground hover:text-foreground shrink-0"
                    >
                      {t("clearTemplate")}
                    </button>
                  )}
                </div>
                {templates.length === 0 && (
                  <p className="text-[0.625rem] text-muted-foreground">{t("noApprovedTemplatesHint")}</p>
                )}

                <div className="flex flex-wrap justify-end gap-2">
                  {row.isSample && row.id && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => saveRow(index, true)}
                      disabled={row.saving}
                      className="border-primary/50 text-primary"
                    >
                      <CheckCircle2 className="mr-1 h-4 w-4" />
                      {t("adoptSample")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => saveRow(index)}
                    disabled={row.saving}
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {row.saving ? t("saving") : row.id ? t("update") : t("create")}
                  </Button>
                </div>
              </div>
            ))}

            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => addRow("before")}
                className="border-border border-dashed text-muted-foreground hover:bg-muted"
              >
                <Plus className="mr-1 h-4 w-4" />
                {t("addRule")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => addRow("after")}
                className="border-border border-dashed text-muted-foreground hover:bg-muted"
              >
                <Plus className="mr-1 h-4 w-4" />
                {t("addFollowUp")}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
