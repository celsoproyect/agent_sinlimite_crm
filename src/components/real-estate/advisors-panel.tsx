"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type { Property } from "@/lib/real-estate/search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiErrorText, type Advisor } from "./properties-utils";

interface AdvisorsPanelProps {
  advisors: Advisor[];
  properties: Property[];
  canManage: boolean;
  onChanged: () => void;
}

/** The advisors who show the properties. They are the clinic module's
 *  `professionals` (same table and routes), so each has their own agenda
 *  for visits: business hours, their visit length, no double booking. */
export function AdvisorsPanel({ advisors, properties, canManage, onChanged }: AdvisorsPanelProps) {
  const t = useTranslations("Properties");
  const [editing, setEditing] = useState<Advisor | "new" | null>(null);

  async function remove(a: Advisor) {
    if (!confirm(t("confirmDeleteAdvisor", { name: a.name }))) return;
    const res = await fetch(`/api/clinic/professionals/${a.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    toast.success(t("deleted"));
    onChanged();
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("advisorsHint")}</p>
      {canManage && (
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="mr-1 h-4 w-4" />
          {t("addAdvisor")}
        </Button>
      )}
      {advisors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {t("noAdvisors")}
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {advisors.map((a) => {
            const count = properties.filter((p) => p.advisor_id === a.id).length;
            return (
              <li key={a.id} className="flex items-start justify-between gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">{a.name}</span>
                    {!a.active && <Badge variant="secondary">{t("inactive")}</Badge>}
                    {a.is_sample && <Badge variant="outline">{t("sample")}</Badge>}
                  </div>
                  {a.bio && <p className="text-xs text-muted-foreground">{a.bio}</p>}
                  <p className="text-xs text-muted-foreground">
                    {t("advisorListings", { count })}
                    {a.slot_minutes ? ` · ${t("visitMinutes", { m: a.slot_minutes })}` : ""}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-0.5">
                    <Button size="icon" variant="ghost" onClick={() => setEditing(a)} aria-label={t("edit")}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => void remove(a)} aria-label={t("delete")}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{editing === "new" ? t("addAdvisor") : t("editAdvisor")}</DialogTitle>
          </DialogHeader>
          {editing && (
            <AdvisorForm
              key={editing === "new" ? "new" : editing.id}
              advisor={editing === "new" ? null : editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                onChanged();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AdvisorForm({ advisor, onCancel, onSaved }: { advisor: Advisor | null; onCancel: () => void; onSaved: () => void }) {
  const t = useTranslations("Properties");
  const [name, setName] = useState(advisor?.name ?? "");
  const [bio, setBio] = useState(advisor?.bio ?? "");
  const [minutes, setMinutes] = useState(advisor?.slot_minutes ? String(advisor.slot_minutes) : "60");
  const [active, setActive] = useState(advisor?.active ?? true);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) {
      toast.error(t("errors.name_required"));
      return;
    }
    setSaving(true);
    const res = await fetch(advisor ? `/api/clinic/professionals/${advisor.id}` : "/api/clinic/professionals", {
      method: advisor ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, bio, active, slot_minutes: minutes ? Number(minutes) : null, ...(advisor ? {} : { kind: "advisor" }) }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      toast.error(res ? await apiErrorText(res, t) : t("errors.generic"));
      return;
    }
    toast.success(t("saved"));
    onSaved();
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>{t("fields.advisorName")}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>{t("fields.advisorBio")}</Label>
        <Textarea rows={2} value={bio} onChange={(e) => setBio(e.target.value)} placeholder={t("fields.advisorBioPlaceholder")} />
      </div>
      <div className="space-y-1.5">
        <Label>{t("fields.visitLength")}</Label>
        <Input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} />
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Switch checked={active} onCheckedChange={setActive} />
        {t("fields.active")}
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t("save")}
        </Button>
      </DialogFooter>
    </div>
  );
}
