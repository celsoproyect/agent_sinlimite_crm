"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Bath, BedDouble, Car, Images, Pencil, Ruler, Search, Trash2 } from "lucide-react";
import { amenityLabel, canonicalAmenity, normalizeText } from "@/lib/real-estate/amenities";
import { PROPERTY_STATUSES, PROPERTY_TYPES, searchProperties, type Property } from "@/lib/real-estate/search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SELECT_CLASS, apiErrorText, formatPrice, type Advisor } from "./properties-utils";

interface PropertyListProps {
  properties: Property[];
  advisors: Advisor[];
  canManage: boolean;
  onEdit: (property: Property) => void;
  onChanged: () => void;
}

/** The inventory with filters. The amenity filter uses the same search
 *  the AI runs, so the owner can check what a customer would be offered. */
export function PropertyList({ properties, advisors, canManage, onEdit, onChanged }: PropertyListProps) {
  const t = useTranslations("Properties");
  const locale = useLocale() === "en" ? "en" : "es";
  const [query, setQuery] = useState("");
  const [operation, setOperation] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [amenityText, setAmenityText] = useState("");

  const advisorName = useMemo(() => new Map(advisors.map((a) => [a.id, a.name])), [advisors]);

  const wanted = useMemo(
    () =>
      amenityText
        .split(/[,;]/)
        .map((a) => canonicalAmenity(a))
        .filter((a): a is string => !!a),
    [amenityText],
  );

  const rows = useMemo(() => {
    const q = normalizeText(query);
    let list = properties.filter(
      (p) =>
        (!operation || p.operation === operation) &&
        (!type || p.property_type === type) &&
        (!status || p.status === status) &&
        (!q ||
          normalizeText([p.title, p.code, p.zone, p.city, p.address].filter(Boolean).join(" ")).includes(q)),
    );
    const coverage = new Map<string, string[]>();
    if (wanted.length > 0) {
      // Same ranking as the AI, over every status so the owner sees all.
      const matches = searchProperties(
        list.map((p) => ({ ...p, active: true, status: "available" as const })),
        { amenities: wanted },
        list.length,
      );
      for (const m of matches) coverage.set(m.property.id, m.missingAmenities);
      list = matches.map((m) => list.find((p) => p.id === m.property.id)!).filter(Boolean);
    }
    return { list, coverage };
  }, [properties, operation, type, status, query, wanted]);

  async function remove(p: Property) {
    if (!confirm(t("confirmDelete", { name: p.title }))) return;
    const res = await fetch(`/api/properties/${p.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    toast.success(t("deleted"));
    onChanged();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 rounded-xl border border-border bg-card p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative lg:col-span-2">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-8" />
        </div>
        <select className={SELECT_CLASS} value={operation} onChange={(e) => setOperation(e.target.value)} aria-label={t("fields.operation")}>
          <option value="">{t("allOperations")}</option>
          <option value="sale">{t("operation.sale")}</option>
          <option value="rent">{t("operation.rent")}</option>
        </select>
        <select className={SELECT_CLASS} value={type} onChange={(e) => setType(e.target.value)} aria-label={t("fields.type")}>
          <option value="">{t("allTypes")}</option>
          {PROPERTY_TYPES.map((k) => (
            <option key={k} value={k}>
              {t(`types.${k}`)}
            </option>
          ))}
        </select>
        <select className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("fields.status")}>
          <option value="">{t("allStatuses")}</option>
          {PROPERTY_STATUSES.map((k) => (
            <option key={k} value={k}>
              {t(`status.${k}`)}
            </option>
          ))}
        </select>
        <Input
          value={amenityText}
          onChange={(e) => setAmenityText(e.target.value)}
          placeholder={t("amenityFilterPlaceholder")}
          className="sm:col-span-2 lg:col-span-5"
        />
      </div>

      {rows.list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {properties.length === 0 ? t("empty") : t("noMatches")}
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.list.map((p) => {
            const missing = rows.coverage.get(p.id);
            return (
              <li key={p.id} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                {p.photos[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- user-uploaded storage URLs
                  <img src={p.photos[0]} alt={p.title} className="aspect-[16/9] w-full object-cover" />
                ) : (
                  <div className="flex aspect-[16/9] w-full items-center justify-center bg-muted text-xs text-muted-foreground">
                    {t("noPhotos")}
                  </div>
                )}
                <div className="flex flex-1 flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={p.operation === "sale" ? "default" : "secondary"}>{t(`operation.${p.operation}`)}</Badge>
                    <Badge variant="outline">{t(`types.${p.property_type}`)}</Badge>
                    {p.status !== "available" && <Badge variant="secondary">{t(`status.${p.status}`)}</Badge>}
                    {!p.active && <Badge variant="secondary">{t("inactive")}</Badge>}
                    {p.is_sample && <Badge variant="outline">{t("sample")}</Badge>}
                    {p.code && <span className="ml-auto text-xs text-muted-foreground">{p.code}</span>}
                  </div>
                  <h3 className="font-medium leading-snug text-foreground">{p.title}</h3>
                  <p className="text-xs text-muted-foreground">{[p.zone, p.city].filter(Boolean).join(", ") || "—"}</p>
                  <p className="text-base font-semibold tabular-nums text-foreground">
                    {formatPrice(p.price, p.currency, locale)}
                    {p.operation === "rent" && p.price != null && (
                      <span className="text-xs font-normal text-muted-foreground"> {t("perMonth")}</span>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                    {p.bedrooms != null && (
                      <span className="inline-flex items-center gap-1">
                        <BedDouble className="h-3.5 w-3.5" />
                        {p.bedrooms}
                      </span>
                    )}
                    {p.bathrooms != null && (
                      <span className="inline-flex items-center gap-1">
                        <Bath className="h-3.5 w-3.5" />
                        {p.bathrooms}
                      </span>
                    )}
                    {p.parking != null && (
                      <span className="inline-flex items-center gap-1">
                        <Car className="h-3.5 w-3.5" />
                        {p.parking}
                      </span>
                    )}
                    {p.area_m2 != null && (
                      <span className="inline-flex items-center gap-1">
                        <Ruler className="h-3.5 w-3.5" />
                        {p.area_m2} m²
                      </span>
                    )}
                    {p.photos.length > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Images className="h-3.5 w-3.5" />
                        {p.photos.length}
                      </span>
                    )}
                  </div>
                  {p.amenities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {p.amenities.map((a) => (
                        <span key={a} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {amenityLabel(a, locale)}
                        </span>
                      ))}
                    </div>
                  )}
                  {missing && (
                    <p className={missing.length ? "text-xs text-destructive" : "text-xs text-primary"}>
                      {missing.length
                        ? t("lacksAmenities", { list: missing.map((a) => amenityLabel(a, locale)).join(", ") })
                        : t("hasAllAmenities")}
                    </p>
                  )}
                  <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                    <span className="truncate text-xs text-muted-foreground">
                      {p.advisor_id && advisorName.get(p.advisor_id)
                        ? t("advisorLabel", { name: advisorName.get(p.advisor_id)! })
                        : t("noAdvisor")}
                    </span>
                    {canManage && (
                      <div className="flex shrink-0 gap-0.5">
                        <Button size="icon" variant="ghost" onClick={() => onEdit(p)} aria-label={t("edit")}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => void remove(p)} aria-label={t("delete")}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
