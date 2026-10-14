"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import type { Property } from "@/lib/real-estate/search";
import { businessDate, businessTime, businessToday } from "@/lib/business-timezone";
import { bookingDisplayName, bookingDisplayPhone, mondayOf } from "@/lib/bookings/ranges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgendaCalendar } from "@/components/agenda/agenda-calendar";
import { ViewToggle, WeekNav, hourTime, useScheduleView } from "@/components/bookings/schedule-view";
import { propertyLabel, type Advisor, type Visit } from "./properties-utils";
import { VisitFormDialog } from "./visit-form-dialog";

interface VisitsListProps {
  visits: Visit[];
  properties: Property[];
  advisors: Advisor[];
  /** Agents and up create and edit visits; viewers only look. */
  canEdit: boolean;
  onChanged: () => void;
}

/** Property visits (bookings with a property_id) as a list or a week
 *  calendar, in business time. Clicking one opens it to edit or move. */
export function VisitsList({ visits, properties, advisors, canEdit, onChanged }: VisitsListProps) {
  const t = useTranslations("Properties");
  const [view, setView] = useScheduleView("properties-visits");
  const [weekStart, setWeekStart] = useState(() => mondayOf(businessToday()));
  const [editing, setEditing] = useState<Visit | null>(null);
  const [creating, setCreating] = useState<{ date?: string; time?: string } | null>(null);
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const advisorName = new Map(advisors.map((a) => [a.id, a.name]));
  // The list starts today; the calendar can go back to past weeks.
  const today = businessToday();
  const upcoming = visits.filter((v) => businessDate(v.starts_at) >= today);

  const propertyText = (v: Visit) => {
    const p = v.property_id ? propertyById.get(v.property_id) : undefined;
    return p ? propertyLabel(p) : v.service || "—";
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ViewToggle value={view} onChange={setView} />
          {view === "calendar" && <WeekNav weekStart={weekStart} onChange={setWeekStart} />}
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setCreating({})}>
            <Plus className="mr-1 h-4 w-4" />
            {t("newVisit")}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{t("visitsHint")}</p>

      {view === "calendar" ? (
        <AgendaCalendar
          weekStart={weekStart}
          bookings={visits}
          onBookingClick={(b) => canEdit && setEditing(b)}
          onSlotClick={canEdit ? (date, hour) => setCreating({ date, time: hourTime(hour) }) : undefined}
          describe={(v) => ({
            title: bookingDisplayName(v) || "—",
            detail: [propertyText(v), v.professional_id ? advisorName.get(v.professional_id) : null].filter(Boolean).join(" · "),
          })}
        />
      ) : upcoming.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {t("noVisits")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("visitWhen")}</th>
                <th className="px-3 py-2 font-medium">{t("visitProperty")}</th>
                <th className="px-3 py-2 font-medium">{t("visitCustomer")}</th>
                <th className="px-3 py-2 font-medium">{t("fields.advisor")}</th>
                <th className="px-3 py-2 font-medium">{t("fields.status")}</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((v) => (
                <tr
                  key={v.id}
                  onClick={canEdit ? () => setEditing(v) : undefined}
                  onKeyDown={
                    canEdit
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setEditing(v);
                          }
                        }
                      : undefined
                  }
                  tabIndex={canEdit ? 0 : undefined}
                  className={`border-b border-border last:border-0 ${canEdit ? "cursor-pointer hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none" : ""}`}
                >
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-foreground">
                    {businessDate(v.starts_at)} · {businessTime(v.starts_at)}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {propertyText(v)}
                    {v.is_sample && (
                      <Badge variant="outline" className="ml-1.5">
                        {t("sample")}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {bookingDisplayName(v) || "—"}
                    {bookingDisplayPhone(v) && <span className="block text-xs text-muted-foreground">{bookingDisplayPhone(v)}</span>}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {(v.professional_id && advisorName.get(v.professional_id)) || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={v.status === "cancelled" ? "secondary" : "outline"}>{t(`visitStatus.${v.status}`)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <VisitFormDialog
        open={!!editing || !!creating}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null);
            setCreating(null);
          }
        }}
        visit={editing}
        properties={properties}
        advisors={advisors}
        defaultDate={creating?.date}
        defaultTime={creating?.time}
        onSaved={onChanged}
      />
    </div>
  );
}
