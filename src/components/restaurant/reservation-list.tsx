"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, Check, Clock, Pencil, UserX, Users } from "lucide-react";
import type { RestaurantTable } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { businessTime } from "@/lib/business-timezone";
import { bookingReference } from "@/lib/bookings/reference";
import { bookingDisplayName, bookingDisplayPhone } from "@/lib/bookings/ranges";
import { cn } from "@/lib/utils";
import { apiErrorText, durationOf, formatMinutes, type Reservation } from "./restaurant-utils";

interface ReservationListProps {
  reservations: Reservation[];
  tables: RestaurantTable[];
  canEdit: boolean;
  /** Opens the reservation in the edit dialog (date, time, people…). */
  onOpen: (reservation: Reservation) => void;
  onChanged: () => void;
}

const STATUS_CLASS: Record<string, string> = {
  confirmed: "bg-primary/15 text-primary",
  completed: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/10 text-destructive",
  no_show: "bg-destructive/10 text-destructive",
};

export function ReservationList({ reservations, tables, canEdit, onOpen, onChanged }: ReservationListProps) {
  const t = useTranslations("Restaurant");
  const tableName = useMemo(() => new Map(tables.map((tb) => [tb.id, tb.name])), [tables]);
  const [busyId, setBusyId] = useState<string | null>(null);

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
                <div
                  role={canEdit ? "button" : undefined}
                  tabIndex={canEdit ? 0 : undefined}
                  onClick={canEdit ? () => onOpen(r) : undefined}
                  onKeyDown={
                    canEdit
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onOpen(r);
                          }
                        }
                      : undefined
                  }
                  className={cn("min-w-0 flex-1 space-y-1", canEdit && "cursor-pointer rounded-md hover:bg-muted/40")}
                >
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

                {canEdit && !live && (
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    <Button size="sm" variant="outline" onClick={() => onOpen(r)}>
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      {t("edit")}
                    </Button>
                  </div>
                )}
                {canEdit && live && (
                  <div className="flex flex-wrap gap-1.5 sm:justify-end">
                    <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => onOpen(r)}>
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      {t("edit")}
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
    </>
  );
}
