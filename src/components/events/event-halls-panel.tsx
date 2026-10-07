"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import type { EventHall, EventSettings } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { effectivePolicy } from "@/lib/events/settings";
import { formatMoney, KNOWN_ERRORS, sendJson } from "./event-utils";

interface Props {
  halls: EventHall[];
  settings: EventSettings;
  canEdit: boolean;
  onChanged: () => Promise<void> | void;
}

interface Draft {
  id: string | null;
  name: string;
  description: string;
  capacity_min: string;
  capacity_max: string;
  price_per_hour: string;
  min_hours: string;
  setup_minutes: string;
  cleanup_minutes: string;
  /** "inherit" | "yes" | "no" */
  approval: string;
  /** Blank = the general setting. */
  deposit_percent: string;
  active: boolean;
}

const str = (n: number | null | undefined) => (n == null ? "" : String(n));

function toDraft(h: EventHall | null): Draft {
  return {
    id: h?.id ?? null,
    name: h?.name ?? "",
    description: h?.description ?? "",
    capacity_min: str(h?.capacity_min ?? 1),
    capacity_max: str(h?.capacity_max ?? 50),
    price_per_hour: str(h?.price_per_hour),
    min_hours: str(h?.min_hours ?? 1),
    setup_minutes: str(h?.setup_minutes ?? 0),
    cleanup_minutes: str(h?.cleanup_minutes ?? 0),
    approval: h?.requires_approval == null ? "inherit" : h.requires_approval ? "yes" : "no",
    deposit_percent: str(h?.deposit_percent),
    active: h?.active ?? true,
  };
}

const selectClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

/** The halls, each with its capacity, price and (optionally) its own
 *  approval and deposit policy. */
export function EventHallsPanel({ halls, settings, canEdit, onChanged }: Props) {
  const t = useTranslations("Events");
  const locale = useLocale();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const fail = (code: string) => toast.error(KNOWN_ERRORS.has(code) ? t(`errors.${code}`) : t("errors.failed"));

  async function save() {
    if (!draft) return;
    setSaving(true);
    const body = {
      name: draft.name,
      description: draft.description,
      capacity_min: draft.capacity_min,
      capacity_max: draft.capacity_max,
      price_per_hour: draft.price_per_hour,
      min_hours: draft.min_hours,
      setup_minutes: draft.setup_minutes || 0,
      cleanup_minutes: draft.cleanup_minutes || 0,
      requires_approval: draft.approval === "inherit" ? null : draft.approval === "yes",
      deposit_percent: draft.deposit_percent,
      active: draft.active,
    };
    const res = await sendJson(draft.id ? `/api/events/halls/${draft.id}` : "/api/events/halls", draft.id ? "PATCH" : "POST", body);
    setSaving(false);
    if (!res.ok) return fail(res.code);
    toast.success(t("common.saved"));
    setDraft(null);
    await onChanged();
  }

  async function remove(hall: EventHall) {
    if (!confirm(t("halls.confirmDelete", { name: hall.name }))) return;
    const res = await sendJson(`/api/events/halls/${hall.id}`, "DELETE");
    if (!res.ok) return fail(res.code);
    toast.success(t("common.deleted"));
    await onChanged();
  }

  function policyLabel(h: EventHall): string {
    const p = effectivePolicy(settings, h);
    const parts = [p.requiresApproval ? t("halls.needsApproval") : t("halls.noApproval")];
    parts.push(p.depositRequired ? t("halls.depositPct", { pct: p.depositPercent }) : t("halls.noDeposit"));
    return parts.join(" · ");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("halls.help")}</p>
        {canEdit && (
          <Button size="sm" onClick={() => setDraft(toDraft(null))} className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="mr-1 h-4 w-4" />
            {t("halls.add")}
          </Button>
        )}
      </div>

      {halls.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("halls.empty")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {halls.map((h) => (
            <div key={h.id} className={`space-y-2 rounded-lg border bg-card p-3 ${h.is_sample ? "border-dashed border-primary/50" : "border-border"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-foreground">{h.name}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {h.is_sample && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary">{t("common.sample")}</span>}
                    {!h.active && <span className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">{t("common.inactive")}</span>}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => setDraft(toDraft(h))} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("common.edit")}>
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => remove(h)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label={t("common.delete")}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              {h.description && <p className="text-xs text-muted-foreground">{h.description}</p>}
              <p className="flex items-center gap-1 text-xs text-foreground">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                {t("halls.capacityRange", { min: h.capacity_min, max: h.capacity_max })}
              </p>
              <p className="text-xs text-foreground">
                {h.price_per_hour != null
                  ? t("halls.pricePerHour", { price: formatMoney(h.price_per_hour, settings.currency, locale) ?? "", hours: Number(h.min_hours) })
                  : t("halls.noPrice")}
              </p>
              <p className="text-xs text-muted-foreground">{policyLabel(h)}</p>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!draft} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{draft?.id ? t("halls.edit") : t("halls.add")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-3 py-1">
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("halls.name")}</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="border-border bg-background" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("halls.description")}</Label>
                <Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="border-border bg-background" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("halls.capacityMin")}</Label>
                  <Input type="number" min={1} value={draft.capacity_min} onChange={(e) => setDraft({ ...draft, capacity_min: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("halls.capacityMax")}</Label>
                  <Input type="number" min={1} value={draft.capacity_max} onChange={(e) => setDraft({ ...draft, capacity_max: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("halls.price", { currency: settings.currency })}</Label>
                  <Input type="number" min={0} value={draft.price_per_hour} onChange={(e) => setDraft({ ...draft, price_per_hour: e.target.value })} placeholder={t("halls.pricePlaceholder")} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("halls.minHours")}</Label>
                  <Input type="number" min={0.5} step={0.5} value={draft.min_hours} onChange={(e) => setDraft({ ...draft, min_hours: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("halls.setup")}</Label>
                  <Input type="number" min={0} value={draft.setup_minutes} onChange={(e) => setDraft({ ...draft, setup_minutes: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("halls.cleanup")}</Label>
                  <Input type="number" min={0} value={draft.cleanup_minutes} onChange={(e) => setDraft({ ...draft, cleanup_minutes: e.target.value })} className="border-border bg-background" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("halls.setupHelp")}</p>

              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3">
                <p className="text-xs font-medium text-foreground">{t("halls.policyTitle")}</p>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("halls.approval")}</Label>
                  <select value={draft.approval} onChange={(e) => setDraft({ ...draft, approval: e.target.value })} className={selectClass}>
                    <option value="inherit">{t("halls.inherit", { value: settings.requires_approval ? t("common.yes") : t("common.no") })}</option>
                    <option value="yes">{t("common.yes")}</option>
                    <option value="no">{t("common.no")}</option>
                  </select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("halls.depositPercent")}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.deposit_percent}
                    onChange={(e) => setDraft({ ...draft, deposit_percent: e.target.value })}
                    placeholder={t("halls.depositPlaceholder", {
                      value: settings.deposit_required ? `${settings.deposit_percent}%` : t("halls.noDeposit"),
                    })}
                    className="border-border bg-background"
                  />
                  <p className="text-xs text-muted-foreground">{t("halls.depositHelp")}</p>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <Label className="text-muted-foreground">{t("common.active")}</Label>
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} className="border-border">
              {t("common.cancel")}
            </Button>
            <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90">
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
