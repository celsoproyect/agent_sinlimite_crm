"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { EventHall, EventPackage, EventSettings } from "@/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney, KNOWN_ERRORS, sendJson } from "./event-utils";

interface Props {
  packages: EventPackage[];
  halls: EventHall[];
  settings: EventSettings;
  canEdit: boolean;
  onChanged: () => Promise<void> | void;
}

interface Draft {
  id: string | null;
  hall_id: string;
  name: string;
  description: string;
  price: string;
  price_per_person: string;
  min_guests: string;
  max_guests: string;
  duration_hours: string;
  active: boolean;
}

const str = (n: number | null | undefined) => (n == null ? "" : String(n));

function toDraft(p: EventPackage | null): Draft {
  return {
    id: p?.id ?? null,
    hall_id: p?.hall_id ?? "",
    name: p?.name ?? "",
    description: p?.description ?? "",
    price: str(p?.price),
    price_per_person: str(p?.price_per_person),
    min_guests: str(p?.min_guests),
    max_guests: str(p?.max_guests),
    duration_hours: str(p?.duration_hours),
    active: p?.active ?? true,
  };
}

const selectClass =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

/** What the halls sell: a fixed price, a price per guest, or both. The AI
 *  quotes from these. */
export function EventPackagesPanel({ packages, halls, settings, canEdit, onChanged }: Props) {
  const t = useTranslations("Events");
  const locale = useLocale();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const hallName = (id: string | null | undefined) => halls.find((h) => h.id === id)?.name;

  const fail = (code: string) => toast.error(KNOWN_ERRORS.has(code) ? t(`errors.${code}`) : t("errors.failed"));

  async function save() {
    if (!draft) return;
    setSaving(true);
    const { id, ...body } = draft;
    const res = await sendJson(id ? `/api/events/packages/${id}` : "/api/events/packages", id ? "PATCH" : "POST", body);
    setSaving(false);
    if (!res.ok) return fail(res.code);
    toast.success(t("common.saved"));
    setDraft(null);
    await onChanged();
  }

  async function remove(p: EventPackage) {
    if (!confirm(t("packages.confirmDelete", { name: p.name }))) return;
    const res = await sendJson(`/api/events/packages/${p.id}`, "DELETE");
    if (!res.ok) return fail(res.code);
    toast.success(t("common.deleted"));
    await onChanged();
  }

  function priceLabel(p: EventPackage): string {
    const parts: string[] = [];
    const fixed = formatMoney(p.price, settings.currency, locale);
    const perPerson = formatMoney(p.price_per_person, settings.currency, locale);
    if (fixed) parts.push(fixed);
    if (perPerson) parts.push(t("packages.perPerson", { price: perPerson }));
    return parts.length ? parts.join(" + ") : t("packages.noPrice");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("packages.help")}</p>
        {canEdit && (
          <Button size="sm" onClick={() => setDraft(toDraft(null))} className="bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="mr-1 h-4 w-4" />
            {t("packages.add")}
          </Button>
        )}
      </div>

      {packages.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("packages.empty")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {packages.map((p) => (
            <div key={p.id} className={`space-y-2 rounded-lg border bg-card p-3 ${p.is_sample ? "border-dashed border-primary/50" : "border-border"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-foreground">{p.name}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.is_sample && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-primary">{t("common.sample")}</span>}
                    {!p.active && <span className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">{t("common.inactive")}</span>}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => setDraft(toDraft(p))} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("common.edit")}>
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => remove(p)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label={t("common.delete")}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
              <p className="text-xs font-medium text-foreground">{priceLabel(p)}</p>
              <p className="text-xs text-muted-foreground">
                {hallName(p.hall_id) ?? t("packages.anyHall")}
                {p.min_guests || p.max_guests ? ` · ${t("packages.guestsRange", { min: p.min_guests ?? 1, max: p.max_guests ?? "∞" })}` : ""}
                {p.duration_hours ? ` · ${t("packages.hours", { hours: Number(p.duration_hours) })}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!draft} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{draft?.id ? t("packages.edit") : t("packages.add")}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="space-y-3 py-1">
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("packages.name")}</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="border-border bg-background" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("packages.description")}</Label>
                <Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={t("packages.descriptionPlaceholder")} className="border-border bg-background" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("packages.hall")}</Label>
                <select value={draft.hall_id} onChange={(e) => setDraft({ ...draft, hall_id: e.target.value })} className={selectClass}>
                  <option value="">{t("packages.anyHall")}</option>
                  {halls.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("packages.price", { currency: settings.currency })}</Label>
                  <Input type="number" min={0} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("packages.pricePerPerson", { currency: settings.currency })}</Label>
                  <Input type="number" min={0} value={draft.price_per_person} onChange={(e) => setDraft({ ...draft, price_per_person: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("packages.minGuests")}</Label>
                  <Input type="number" min={1} value={draft.min_guests} onChange={(e) => setDraft({ ...draft, min_guests: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("packages.maxGuests")}</Label>
                  <Input type="number" min={1} value={draft.max_guests} onChange={(e) => setDraft({ ...draft, max_guests: e.target.value })} className="border-border bg-background" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground">{t("packages.duration")}</Label>
                  <Input type="number" min={0.5} step={0.5} value={draft.duration_hours} onChange={(e) => setDraft({ ...draft, duration_hours: e.target.value })} className="border-border bg-background" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("packages.priceHelp")}</p>
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
