"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { RestaurantArea, RestaurantTable } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SELECT_CLASS, apiErrorText } from "./restaurant-utils";

interface FloorManagerProps {
  areas: RestaurantArea[];
  tables: RestaurantTable[];
  canManage: boolean;
  onChanged: () => void;
}

/** Areas (Salón, Terraza…) and their tables. Tables with upcoming
 *  reservations can't be deleted, only deactivated. */
export function FloorManager({ areas, tables, canManage, onChanged }: FloorManagerProps) {
  const t = useTranslations("Restaurant");
  const [areaDialog, setAreaDialog] = useState<RestaurantArea | "new" | null>(null);
  const [tableDialog, setTableDialog] = useState<RestaurantTable | "new" | null>(null);

  async function send(url: string, method: string, body?: unknown): Promise<boolean> {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return false;
    }
    onChanged();
    return true;
  }

  const groups: { area: RestaurantArea | null; tables: RestaurantTable[] }[] = [
    ...areas.map((a) => ({ area: a, tables: tables.filter((tb) => tb.area_id === a.id) })),
    { area: null, tables: tables.filter((tb) => !tb.area_id || !areas.some((a) => a.id === tb.area_id)) },
  ].filter((g) => g.area || g.tables.length > 0);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setAreaDialog("new")}>
            <Plus className="mr-1 h-4 w-4" />
            {t("addArea")}
          </Button>
          <Button size="sm" onClick={() => setTableDialog("new")}>
            <Plus className="mr-1 h-4 w-4" />
            {t("addTable")}
          </Button>
        </div>
      )}

      {groups.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {t("noTablesYet")}
        </div>
      )}

      {groups.map(({ area, tables: list }) => (
        <section key={area?.id ?? "none"} className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium text-foreground">{area ? area.name : t("noArea")}</h3>
              {area && !area.active && <Badge variant="secondary">{t("inactive")}</Badge>}
              {area?.is_sample && <Badge variant="outline">{t("sample")}</Badge>}
            </div>
            {canManage && area && (
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" onClick={() => setAreaDialog(area)} aria-label={t("edit")}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("delete")}
                  onClick={() => {
                    if (confirm(t("confirmDeleteArea", { name: area.name }))) {
                      void send(`/api/restaurant/areas/${area.id}`, "DELETE");
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            )}
          </div>
          {area?.description && <p className="mb-2 text-xs text-muted-foreground">{area.description}</p>}
          {list.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("areaEmpty")}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((tb) => (
                <li key={tb.id} className="flex items-start justify-between gap-2 rounded-lg border border-border p-2.5">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">{tb.name}</span>
                      {!tb.active && <Badge variant="secondary">{t("inactive")}</Badge>}
                      {tb.is_sample && <Badge variant="outline">{t("sample")}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("seatsRange", { min: tb.min_party, max: tb.max_party })}
                      {tb.combinable ? ` · ${t("combinableShort")}` : ""}
                    </p>
                    {tb.notes && <p className="text-xs text-muted-foreground">{tb.notes}</p>}
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 gap-0.5">
                      <Button size="icon" variant="ghost" onClick={() => setTableDialog(tb)} aria-label={t("edit")}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("delete")}
                        onClick={() => {
                          if (confirm(t("confirmDeleteTable", { name: tb.name }))) {
                            void send(`/api/restaurant/tables/${tb.id}`, "DELETE");
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <Dialog open={!!areaDialog} onOpenChange={(o) => !o && setAreaDialog(null)}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {areaDialog === "new" ? t("addArea") : t("editArea")}
            </DialogTitle>
          </DialogHeader>
          {areaDialog && (
            <AreaForm
              key={areaDialog === "new" ? "new" : areaDialog.id}
              area={areaDialog === "new" ? null : areaDialog}
              onCancel={() => setAreaDialog(null)}
              onSave={async (body) => {
                const ok =
                  areaDialog === "new"
                    ? await send("/api/restaurant/areas", "POST", body)
                    : await send(`/api/restaurant/areas/${areaDialog.id}`, "PATCH", body);
                if (ok) {
                  toast.success(t("saved"));
                  setAreaDialog(null);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!tableDialog} onOpenChange={(o) => !o && setTableDialog(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {tableDialog === "new" ? t("addTable") : t("editTable")}
            </DialogTitle>
          </DialogHeader>
          {tableDialog && (
            <TableForm
              key={tableDialog === "new" ? "new" : tableDialog.id}
              table={tableDialog === "new" ? null : tableDialog}
              areas={areas}
              onCancel={() => setTableDialog(null)}
              onSave={async (body) => {
                const ok =
                  tableDialog === "new"
                    ? await send("/api/restaurant/tables", "POST", body)
                    : await send(`/api/restaurant/tables/${tableDialog.id}`, "PATCH", body);
                if (ok) {
                  toast.success(t("saved"));
                  setTableDialog(null);
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AreaForm({
  area,
  onCancel,
  onSave,
}: {
  area: RestaurantArea | null;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations("Restaurant");
  const [name, setName] = useState(area?.name ?? "");
  const [description, setDescription] = useState(area?.description ?? "");
  const [active, setActive] = useState(area?.active ?? true);
  const [saving, setSaving] = useState(false);

  return (
    <>
      <div className="space-y-4 py-2">
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("areaName")}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("areaNamePlaceholder")}
            className="border-border bg-muted"
          />
        </div>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("description")}</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="border-border bg-muted"
          />
        </div>
        <label className="flex items-center justify-between gap-3 text-sm text-foreground">
          {t("active")}
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
      </div>
      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          disabled={saving || !name.trim()}
          onClick={async () => {
            setSaving(true);
            await onSave({ name, description: description || null, active });
            setSaving(false);
          }}
        >
          {saving ? t("saving") : t("save")}
        </Button>
      </DialogFooter>
    </>
  );
}

function TableForm({
  table,
  areas,
  onCancel,
  onSave,
}: {
  table: RestaurantTable | null;
  areas: RestaurantArea[];
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations("Restaurant");
  const [name, setName] = useState(table?.name ?? "");
  const [areaId, setAreaId] = useState(table?.area_id ?? "");
  const [minParty, setMinParty] = useState(String(table?.min_party ?? 1));
  const [maxParty, setMaxParty] = useState(String(table?.max_party ?? 4));
  const [combinable, setCombinable] = useState(table?.combinable ?? true);
  const [active, setActive] = useState(table?.active ?? true);
  const [notes, setNotes] = useState(table?.notes ?? "");
  const [saving, setSaving] = useState(false);

  return (
    <>
      <div className="space-y-4 py-2">
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("tableName")}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("tableNamePlaceholder")}
            className="border-border bg-muted"
          />
        </div>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("area")}</Label>
          <select value={areaId} onChange={(e) => setAreaId(e.target.value)} className={SELECT_CLASS}>
            <option value="">{t("noArea")}</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("minParty")}</Label>
            <Input
              type="number"
              min={1}
              value={minParty}
              onChange={(e) => setMinParty(e.target.value)}
              className="border-border bg-muted"
            />
          </div>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("maxParty")}</Label>
            <Input
              type="number"
              min={1}
              value={maxParty}
              onChange={(e) => setMaxParty(e.target.value)}
              className="border-border bg-muted"
            />
          </div>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm text-foreground">
          <span>
            {t("combinable")}
            <span className="block text-xs text-muted-foreground">{t("combinableHint")}</span>
          </span>
          <Switch checked={combinable} onCheckedChange={setCombinable} />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm text-foreground">
          <span>
            {t("active")}
            <span className="block text-xs text-muted-foreground">{t("activeTableHint")}</span>
          </span>
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
        <div className="grid gap-2">
          <Label className="text-muted-foreground">{t("notes")}</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="border-border bg-muted" />
        </div>
      </div>
      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          disabled={saving || !name.trim()}
          onClick={async () => {
            setSaving(true);
            await onSave({
              name,
              area_id: areaId || null,
              min_party: Number(minParty),
              max_party: Number(maxParty),
              combinable,
              active,
              notes: notes || null,
            });
            setSaving(false);
          }}
        >
          {saving ? t("saving") : t("save")}
        </Button>
      </DialogFooter>
    </>
  );
}
