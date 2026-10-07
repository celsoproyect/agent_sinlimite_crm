"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Users } from "lucide-react";
import type { WaitlistEntry, WaitlistStatus } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SELECT_CLASS, apiErrorText } from "./restaurant-utils";

interface WaitlistPanelProps {
  date: string;
  canEdit: boolean;
}

const STATUSES: WaitlistStatus[] = ["waiting", "notified", "seated", "cancelled", "expired"];

/** The day's waitlist: people who asked for a table when none was free.
 *  "Avisado" only records that the team wrote to them. */
export function WaitlistPanel({ date, canEdit }: WaitlistPanelProps) {
  const t = useTranslations("Restaurant");
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [party, setParty] = useState("2");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/restaurant/waitlist?date=${date}`);
    if (res.ok) {
      const json = (await res.json()) as { entries?: WaitlistEntry[] };
      setEntries(json.entries ?? []);
    } else {
      setEntries([]);
    }
    setLoading(false);
  }, [date]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the day's entries
    void load();
  }, [load]);

  async function add() {
    if ((!name.trim() && !phone.trim()) || !Number(party)) {
      toast.error(t("errors.required_fields"));
      return;
    }
    setAdding(true);
    const res = await fetch("/api/restaurant/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date,
        party_size: Number(party),
        customer_name: name || null,
        customer_phone: phone || null,
        preferred_time: time || null,
        notes: notes || null,
      }),
    });
    setAdding(false);
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    setName("");
    setPhone("");
    setParty("2");
    setTime("");
    setNotes("");
    toast.success(t("waitlistAdded"));
    void load();
  }

  async function setStatus(entry: WaitlistEntry, status: WaitlistStatus) {
    const res = await fetch(`/api/restaurant/waitlist/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    void load();
  }

  async function remove(entry: WaitlistEntry) {
    if (!confirm(t("confirmDeleteWaitlist"))) return;
    const res = await fetch(`/api/restaurant/waitlist/${entry.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    void load();
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-medium text-foreground">{t("waitlistAdd")}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("customerName")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="border-border bg-muted" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("phone")}</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="border-border bg-muted" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("people")}</Label>
              <Input
                type="number"
                min={1}
                value={party}
                onChange={(e) => setParty(e.target.value)}
                className="border-border bg-muted"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("preferredTime")}</Label>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="border-border bg-muted" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("notes")}</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="border-border bg-muted" />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={add} disabled={adding}>
              <Plus className="mr-1 h-4 w-4" />
              {t("waitlistAddButton")}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {t("waitlistEmpty")}
        </div>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{e.customer_name || e.customer_phone}</span>
                  {e.is_sample && <Badge variant="outline">{t("sample")}</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    {t("peopleCount", { count: e.party_size })}
                  </span>
                  {e.preferred_time && <span>{t("preferredTimeLine", { time: e.preferred_time.slice(0, 5) })}</span>}
                  {e.customer_name && e.customer_phone && <span>{e.customer_phone}</span>}
                  {e.notes && <span>{e.notes}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={e.status}
                  disabled={!canEdit}
                  onChange={(ev) => void setStatus(e, ev.target.value as WaitlistStatus)}
                  className={`${SELECT_CLASS} sm:w-40`}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`waitlistStatus.${s}`)}
                    </option>
                  ))}
                </select>
                {canEdit && (
                  <Button size="icon" variant="ghost" onClick={() => remove(e)} aria-label={t("delete")}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
