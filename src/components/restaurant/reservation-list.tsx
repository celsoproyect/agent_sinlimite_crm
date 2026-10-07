"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, Check, Clock, UserX, Users } from "lucide-react";
import type { RestaurantTable } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { businessTime } from "@/lib/business-timezone";
import { bookingReference } from "@/lib/bookings/reference";
import { bookingDisplayName, bookingDisplayPhone } from "@/lib/bookings/ranges";
import { cn } from "@/lib/utils";
import { DURATION_PRESETS, apiErrorText, durationOf, formatMinutes, type Reservation } from "./restaurant-utils";

interface ReservationListProps {
  reservations: Reservation[];
  tables: RestaurantTable[];
  canEdit: boolean;
  defaultDuration: number;
  onChanged: () => void;
}

const STATUS_CLASS: Record<string, string> = {
  confirmed: "bg-primary/15 text-primary",
  completed: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/10 text-destructive",
  no_show: "bg-destructive/10 text-destructive",
};

export function ReservationList({ reservations, tables, canEdit, defaultDuration, onChanged }: ReservationListProps) {
  const t = useTranslations("Restaurant");
  const tableName = useMemo(() => new Map(tables.map((tb) => [tb.id, tb.name])), [tables]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Reservation | null>(null);

  async function patch(id: string, body: Record<string, unknown>, okText: string): Promise<boolean> {
    setBusyId(id);
    const res = await fetch(`/api/restaurant/reservations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusyId(null);
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return false;
    }
    toast.success(okText);
    onChanged();
    return true;
  }

  function setStatus(r: Reservation, status: "completed" | "no_show" | "cancelled") {
    if (status === "cancelled" && !confirm(t("confirmCancel"))) return;
    void patch(r.id, { status }, t(`statusSaved.${status}`));
  }

  if (reservations.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
        {t("noReservations")}
      </div>
    );
  }

  return (
    <>
      <ul className="space-y-2">
        {reservations.map((r) => {
          const minutes = durationOf(r);
          const names = (r.table_ids ?? []).map((id) => tableName.get(id) ?? "?");
          const live = r.status === "confirmed";
          const status = r.status as string;
          return (
            <li key={r.id} className="rounded-xl border border-border bg-card p-3 shadow-sm">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">
                      {businessTime(r.starts_at)}–{businessTime(r.ends_at)}
                    </span>
                    <span className="truncate text-sm text-foreground">{bookingDisplayName(r)}</span>
                    <Badge className={STATUS_CLASS[status] ?? "bg-muted text-muted-foreground"}>
                      {t(`status.${status}`)}
                    </Badge>
                    {r.is_sample && <Badge variant="outline">{t("sample")}</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" />
                      {t("peopleCount", { count: r.party_size ?? 0 })}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      {formatMinutes(t, minutes)}
                    </span>
                    {names.length > 0 && <span>{t("tablesList", { tables: names.join(", ") })}</span>}
                    {names.length > 1 && (
                      <Badge variant="secondary">
                        {r.seating === "separate" ? t("seatingSeparateShort") : t("seatingJoinedShort")}
                      </Badge>
                    )}
                    <span>{bookingReference(r.id, "table")}</span>
                    {bookingDisplayPhone(r) && <span>{bookingDisplayPhone(r)}</span>}
                  </div>
                  {r.occasion && <p className="text-xs text-foreground">{t("occasionLine", { occasion: r.occasion })}</p>}
                  {r.preorder && r.preorder.length > 0 && (
                    <p className="text-xs text-foreground">
                      {t("preorderLine", {
                        items: r.preorder.map((p) => `${p.qty}× ${p.item}${p.notes ? ` (${p.notes})` : ""}`).join(", "),
                      })}
                    </p>
                  )}
                  {r.notes && <p className="text-xs text-muted-foreground">{r.notes}</p>}
                </div>

                {canEdit && live && (
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => setEditing(r)}>
                      <Clock className="mr-1 h-3.5 w-3.5" />
                      {t("duration")}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => setStatus(r, "completed")}>
                      <Check className="mr-1 h-3.5 w-3.5" />
                      {t("complete")}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => setStatus(r, "no_show")}>
                      <UserX className="mr-1 h-3.5 w-3.5" />
                      {t("noShow")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === r.id}
                      onClick={() => setStatus(r, "cancelled")}
                      className="text-destructive"
                    >
                      <Ban className="mr-1 h-3.5 w-3.5" />
                      {t("cancelReservation")}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <DurationDialog
        reservation={editing}
        defaultDuration={defaultDuration}
        onClose={() => setEditing(null)}
        onSave={async (r, minutes) => {
          const ok = await patch(r.id, { duration_minutes: minutes }, t("durationSaved"));
          if (ok) setEditing(null);
        }}
      />
    </>
  );
}

function DurationDialog({
  reservation,
  defaultDuration,
  onClose,
  onSave,
}: {
  reservation: Reservation | null;
  defaultDuration: number;
  onClose: () => void;
  onSave: (r: Reservation, minutes: number) => Promise<void>;
}) {
  const t = useTranslations("Restaurant");
  return (
    <Dialog open={!!reservation} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("editDuration")}</DialogTitle>
        </DialogHeader>
        {/* Keyed by reservation so the field starts at its current length. */}
        {reservation && (
          <DurationForm
            key={reservation.id}
            reservation={reservation}
            defaultDuration={defaultDuration}
            onClose={onClose}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DurationForm({
  reservation,
  defaultDuration,
  onClose,
  onSave,
}: {
  reservation: Reservation;
  defaultDuration: number;
  onClose: () => void;
  onSave: (r: Reservation, minutes: number) => Promise<void>;
}) {
  const t = useTranslations("Restaurant");
  const [value, setValue] = useState(String(durationOf(reservation)));
  const [saving, setSaving] = useState(false);
  const presets = [...new Set([defaultDuration, ...DURATION_PRESETS])].sort((a, b) => a - b);
  const minutes = Number(value);

  return (
    <>
      <div className="space-y-3 py-2">
        <p className="text-xs text-muted-foreground">
          {t("editDurationHint", { start: businessTime(reservation.starts_at) })}
        </p>
        <div className="flex flex-wrap gap-2">
          {presets.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setValue(String(m))}
              className={cn(
                "rounded-md border px-2 py-1 text-xs",
                minutes === m
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {formatMinutes(t, m)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={15}
            step={15}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-28 border-border bg-muted"
          />
          <span className="text-sm text-muted-foreground">{t("minutes")}</span>
        </div>
      </div>
      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          disabled={saving || !Number.isFinite(minutes) || minutes < 15}
          onClick={async () => {
            setSaving(true);
            await onSave(reservation, Math.round(minutes));
            setSaving(false);
          }}
        >
          {saving ? t("saving") : t("save")}
        </Button>
      </DialogFooter>
    </>
  );
}
