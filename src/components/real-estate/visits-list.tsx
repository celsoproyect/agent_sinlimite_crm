"use client";

import { useTranslations } from "next-intl";
import type { Property } from "@/lib/real-estate/search";
import { businessDate, businessTime } from "@/lib/business-timezone";
import { Badge } from "@/components/ui/badge";
import type { Advisor, Visit } from "./properties-utils";

interface VisitsListProps {
  visits: Visit[];
  properties: Property[];
  advisors: Advisor[];
}

/** Upcoming property visits (bookings with a property_id), in business
 *  time. They are agenda appointments too, so they're edited there. */
export function VisitsList({ visits, properties, advisors }: VisitsListProps) {
  const t = useTranslations("Properties");
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const advisorName = new Map(advisors.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("visitsHint")}</p>
      {visits.length === 0 ? (
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
              {visits.map((v) => {
                const p = v.property_id ? propertyById.get(v.property_id) : undefined;
                return (
                  <tr key={v.id} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-foreground">
                      {businessDate(v.starts_at)} · {businessTime(v.starts_at)}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      {p ? `${p.code ? `${p.code} · ` : ""}${p.title}` : (v.service ?? "—")}
                      {v.is_sample && (
                        <Badge variant="outline" className="ml-1.5">
                          {t("sample")}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      {v.customer_name ?? "—"}
                      {v.customer_phone && <span className="block text-xs text-muted-foreground">{v.customer_phone}</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {(v.professional_id && advisorName.get(v.professional_id)) || "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={v.status === "cancelled" ? "secondary" : "outline"}>{t(`visitStatus.${v.status}`)}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
