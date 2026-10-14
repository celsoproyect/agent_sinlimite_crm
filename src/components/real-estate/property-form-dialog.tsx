"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ImagePlus, Loader2, Plus, X } from "lucide-react";
import { AMENITIES, amenityLabel, canonicalAmenity } from "@/lib/real-estate/amenities";
import { PROPERTY_STATUSES, PROPERTY_TYPES, type Property } from "@/lib/real-estate/search";
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SELECT_CLASS, apiErrorText, type Advisor } from "./properties-utils";

const MAX_PHOTOS = 20;

interface PropertyFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = new listing. */
  property: Property | null;
  advisors: Advisor[];
  onSaved: () => void;
}

export function PropertyFormDialog({ open, onOpenChange, property, advisors, onSaved }: PropertyFormDialogProps) {
  const t = useTranslations("Properties");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{property ? t("editProperty") : t("newProperty")}</DialogTitle>
        </DialogHeader>
        {open && (
          <PropertyForm
            key={property?.id ?? "new"}
            property={property}
            advisors={advisors}
            onCancel={() => onOpenChange(false)}
            onSaved={() => {
              onOpenChange(false);
              onSaved();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const numText = (n: number | null | undefined) => (n == null ? "" : String(n));

function PropertyForm({
  property,
  advisors,
  onCancel,
  onSaved,
}: {
  property: Property | null;
  advisors: Advisor[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Properties");
  const locale = useLocale() === "en" ? "en" : "es";
  const [title, setTitle] = useState(property?.title ?? "");
  const [code, setCode] = useState(property?.code ?? "");
  const [operation, setOperation] = useState<string>(property?.operation ?? "sale");
  const [type, setType] = useState<string>(property?.property_type ?? "apartment");
  const [status, setStatus] = useState<string>(property?.status ?? "available");
  const [zone, setZone] = useState(property?.zone ?? "");
  const [city, setCity] = useState(property?.city ?? "");
  const [address, setAddress] = useState(property?.address ?? "");
  const [price, setPrice] = useState(numText(property?.price));
  const [currency, setCurrency] = useState(property?.currency ?? "USD");
  const [bedrooms, setBedrooms] = useState(numText(property?.bedrooms));
  const [bathrooms, setBathrooms] = useState(numText(property?.bathrooms));
  const [parking, setParking] = useState(numText(property?.parking));
  const [area, setArea] = useState(numText(property?.area_m2));
  const [amenities, setAmenities] = useState<string[]>(property?.amenities ?? []);
  const [customAmenity, setCustomAmenity] = useState("");
  const [description, setDescription] = useState(property?.description ?? "");
  const [photos, setPhotos] = useState<string[]>(property?.photos ?? []);
  const [advisorId, setAdvisorId] = useState(property?.advisor_id ?? "");
  const [active, setActive] = useState(property?.active ?? true);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const known = new Set(AMENITIES.map((a) => a.key));
  const custom = amenities.filter((a) => !known.has(a));

  function toggleAmenity(key: string) {
    setAmenities((list) => (list.includes(key) ? list.filter((a) => a !== key) : [...list, key]));
  }

  function addCustomAmenity() {
    const key = canonicalAmenity(customAmenity);
    if (key && !amenities.includes(key)) setAmenities((list) => [...list, key]);
    setCustomAmenity("");
  }

  async function uploadPhotos(files: FileList | null) {
    if (!files?.length) return;
    const picked = Array.from(files).slice(0, MAX_PHOTOS - photos.length);
    setUploading(true);
    const added: string[] = [];
    for (const file of picked) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
        toast.error(t("photoTooLarge", { name: file.name }));
        continue;
      }
      try {
        const { publicUrl } = await uploadAccountMedia("chat-media", file);
        added.push(publicUrl);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("errors.generic"));
      }
    }
    setPhotos((list) => [...list, ...added].slice(0, MAX_PHOTOS));
    setUploading(false);
  }

  async function save() {
    if (!title.trim()) {
      toast.error(t("errors.title_required"));
      return;
    }
    setSaving(true);
    const body = {
      title,
      code,
      operation,
      property_type: type,
      status,
      zone,
      city,
      address,
      price,
      currency,
      bedrooms,
      bathrooms,
      parking,
      area_m2: area,
      amenities,
      description,
      photos,
      advisor_id: advisorId || null,
      active,
    };
    const res = await fetch(property ? `/api/properties/${property.id}` : "/api/properties", {
      method: property ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <div className="space-y-1.5">
          <Label>{t("fields.title")}</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("fields.titlePlaceholder")} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.code")}</Label>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A-101" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>{t("fields.operation")}</Label>
          <select className={SELECT_CLASS} value={operation} onChange={(e) => setOperation(e.target.value)}>
            <option value="sale">{t("operation.sale")}</option>
            <option value="rent">{t("operation.rent")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.type")}</Label>
          <select className={SELECT_CLASS} value={type} onChange={(e) => setType(e.target.value)}>
            {PROPERTY_TYPES.map((k) => (
              <option key={k} value={k}>
                {t(`types.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.status")}</Label>
          <select className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value)}>
            {PROPERTY_STATUSES.map((k) => (
              <option key={k} value={k}>
                {t(`status.${k}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>{t("fields.zone")}</Label>
          <Input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Piantini" />
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.city")}</Label>
          <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Santo Domingo" />
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.address")}</Label>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
        <div className="space-y-1.5">
          <Label>{operation === "rent" ? t("fields.priceRent") : t("fields.price")}</Label>
          <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.currency")}</Label>
          <select className={SELECT_CLASS} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {["USD", "DOP", "EUR"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label>{t("fields.bedrooms")}</Label>
          <Input inputMode="numeric" value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.bathrooms")}</Label>
          <Input inputMode="decimal" value={bathrooms} onChange={(e) => setBathrooms(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.parking")}</Label>
          <Input inputMode="numeric" value={parking} onChange={(e) => setParking(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("fields.area")}</Label>
          <Input inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>{t("fields.amenities")}</Label>
        <p className="text-xs text-muted-foreground">{t("amenitiesHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          {AMENITIES.map((a) => {
            const on = amenities.includes(a.key);
            return (
              <button
                key={a.key}
                type="button"
                onClick={() => toggleAmenity(a.key)}
                aria-pressed={on}
                className={
                  on
                    ? "rounded-full border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                    : "rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                }
              >
                {amenityLabel(a.key, locale)}
              </button>
            );
          })}
          {custom.map((a) => (
            <span
              key={a}
              className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
            >
              {amenityLabel(a, locale)}
              <button type="button" onClick={() => toggleAmenity(a)} aria-label={t("remove")}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={customAmenity}
            onChange={(e) => setCustomAmenity(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustomAmenity();
              }
            }}
            placeholder={t("customAmenityPlaceholder")}
          />
          <Button type="button" variant="outline" size="sm" onClick={addCustomAmenity} disabled={!customAmenity.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>{t("fields.description")}</Label>
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="space-y-2">
        <Label>{t("fields.photos")}</Label>
        <div className="flex flex-wrap gap-2">
          {photos.map((url, i) => (
            <div key={url} className="relative h-20 w-24 overflow-hidden rounded-lg border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded storage URLs */}
              <img src={url} alt={`${title} ${i + 1}`} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => setPhotos((list) => list.filter((p) => p !== url))}
                className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white"
                aria-label={t("remove")}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {photos.length < MAX_PHOTOS && (
            <label className="flex h-20 w-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:text-foreground">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              {t("addPhotos")}
              <input
                type="file"
                accept="image/jpeg,image/png"
                multiple
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  void uploadPhotos(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("photosHint")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t("fields.advisor")}</Label>
          <select className={SELECT_CLASS} value={advisorId} onChange={(e) => setAdvisorId(e.target.value)}>
            <option value="">{t("noAdvisor")}</option>
            {advisors
              .filter((a) => a.active || a.id === advisorId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-foreground">
          <Switch checked={active} onCheckedChange={setActive} />
          {t("fields.active")}
        </label>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={saving || uploading}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t("save")}
        </Button>
      </DialogFooter>
    </div>
  );
}
