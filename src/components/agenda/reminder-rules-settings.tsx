"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { BookingReminderRule, MessageTemplate } from "@/types";
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
import { Plus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface ReminderRulesSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type OffsetUnit = "minutes" | "hours" | "days";

interface RuleRow {
  id: string | null; // null = not yet saved
  offsetValue: number;
  offsetUnit: OffsetUnit;
  messageText: string;
  templateName: string | null;
  templateLanguage: string | null;
  enabled: boolean;
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
    ...minutesToRow(rule.offset_minutes),
    messageText: rule.message_text,
    templateName: rule.template_name ?? null,
    templateLanguage: rule.template_language ?? null,
    enabled: rule.enabled,
    saving: false,
  };
}

const DEFAULT_ROWS: RuleRow[] = [
  { id: null, offsetValue: 24, offsetUnit: "hours", messageText: "", templateName: null, templateLanguage: null, enabled: true, saving: false },
  { id: null, offsetValue: 6, offsetUnit: "hours", messageText: "", templateName: null, templateLanguage: null, enabled: true, saving: false },
  { id: null, offsetValue: 60, offsetUnit: "minutes", messageText: "", templateName: null, templateLanguage: null, enabled: true, saving: false },
];

export function ReminderRulesSettings({ open, onOpenChange }: ReminderRulesSettingsProps) {
  const t = useTranslations("Agenda.reminders");
  const supabase = createClient();

  const [rows, setRows] = useState<RuleRow[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [rulesRes, templatesRes] = await Promise.all([
        fetch("/api/bookings/reminder-rules"),
        supabase
          .from("message_templates")
          .select("*")
          .eq("status", "APPROVED")
          .order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;

      if (rulesRes.ok) {
        const json = await rulesRes.json();
        const loaded = (json.rules ?? []) as BookingReminderRule[];
        setRows(loaded.length > 0 ? loaded.map(ruleToRow) : DEFAULT_ROWS.map((r) => ({ ...r })));
      } else {
        setRows(DEFAULT_ROWS.map((r) => ({ ...r })));
      }
      setTemplates((templatesRes.data as MessageTemplate[]) ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  function updateRow(index: number, patch: Partial<RuleRow>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        id: null,
        offsetValue: 60,
        offsetUnit: "minutes",
        messageText: "",
        templateName: null,
        templateLanguage: null,
        enabled: true,
        saving: false,
      },
    ]);
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

  async function saveRow(index: number) {
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
    const payload = {
      offset_minutes: offsetMinutes,
      message_text: row.messageText,
      template_name: row.templateName,
      template_language: row.templateLanguage,
      enabled: row.enabled,
    };

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
      toast.error(json?.error ?? t("toastFailedSave"));
      updateRow(index, { saving: false });
      return;
    }
    const json = await res.json();
    const saved = json.rule as BookingReminderRule;
    updateRow(index, { ...ruleToRow(saved) });
    toast.success(t("toastSaved"));
  }

  function pickTemplate(index: number, name: string | null) {
    const template = templates.find((tpl) => tpl.name === name) ?? null;
    updateRow(index, {
      templateName: template?.name ?? null,
      templateLanguage: template?.language ?? null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2">
            {rows.map((row, index) => (
              <div
                key={row.id ?? `new-${index}`}
                className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3"
              >
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground shrink-0">{t("offsetLabel")}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={row.offsetValue}
                    onChange={(e) => updateRow(index, { offsetValue: Number(e.target.value) || 0 })}
                    className="h-8 w-20 border-border bg-background text-xs text-foreground"
                  />
                  <Select
                    value={row.offsetUnit}
                    onValueChange={(val) => {
                      if (!val) return;
                      updateRow(index, { offsetUnit: val as OffsetUnit });
                    }}
                  >
                    <SelectTrigger className="h-8 w-32 border-border bg-background text-xs text-foreground">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem value="minutes" className="text-popover-foreground focus:bg-muted focus:text-popover-foreground">
                        {t("unitMinutes")}
                      </SelectItem>
                      <SelectItem value="hours" className="text-popover-foreground focus:bg-muted focus:text-popover-foreground">
                        {t("unitHours")}
                      </SelectItem>
                      <SelectItem value="days" className="text-popover-foreground focus:bg-muted focus:text-popover-foreground">
                        {t("unitDays")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">{t("beforeAppointment")}</span>

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

                <div className="space-y-1">
                  <Textarea
                    value={row.messageText}
                    onChange={(e) => updateRow(index, { messageText: e.target.value })}
                    placeholder={t.raw("messagePlaceholder")}
                    rows={2}
                    className="border-border bg-background text-xs text-foreground"
                  />
                  <p className="text-[0.625rem] text-muted-foreground">{t.raw("placeholderHelp")}</p>
                </div>

                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground shrink-0">{t("fallbackTemplate")}</Label>
                  <Select
                    value={row.templateName ?? undefined}
                    onValueChange={(val) => pickTemplate(index, val || null)}
                  >
                    <SelectTrigger className="h-8 flex-1 border-border bg-background text-xs text-foreground">
                      <SelectValue placeholder={t("noTemplate")} />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      {templates.map((tpl) => (
                        <SelectItem
                          key={tpl.id}
                          value={tpl.name}
                          className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                        >
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

                <div className="flex justify-end">
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

            <Button
              type="button"
              variant="outline"
              onClick={addRow}
              className="w-full border-border border-dashed text-muted-foreground hover:bg-muted"
            >
              <Plus className="mr-1 h-4 w-4" />
              {t("addRule")}
            </Button>
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
