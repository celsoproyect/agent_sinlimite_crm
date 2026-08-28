"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import type { CatalogItem } from "./catalog-item-card";

interface CatalogItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: CatalogItem | null;
  onSaved: () => void;
}

export function CatalogItemDialog({
  open,
  onOpenChange,
  item,
  onSaved,
}: CatalogItemDialogProps) {
  const t = useTranslations("Settings.aiAttachments");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prop-driven reset every time the dialog opens or its target changes.
  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? "");
    setDescription(item?.description ?? "");
    setPrice(item?.price != null ? String(item.price) : "");
    setCurrency(item?.currency ?? "");
    setFile(null);
  }, [open, item]);

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    if (picked.size > MEDIA_MAX_BYTES) {
      toast.error(t("fileTooLarge"));
      return;
    }
    setFile(picked);
  };

  const save = async () => {
    if (!name.trim() || !description.trim()) {
      toast.error(t("nameDescriptionRequired"));
      return;
    }
    const trimmedPrice = price.trim();
    const parsedPrice = trimmedPrice === "" ? null : Number(trimmedPrice);
    if (parsedPrice !== null && (!Number.isFinite(parsedPrice) || parsedPrice < 0)) {
      toast.error(t("priceInvalid"));
      return;
    }
    const isNew = item === null;
    if (isNew && !file) {
      toast.error(t("fileRequired"));
      return;
    }
    setSaving(true);
    try {
      // A freshly picked file uploads the same way whether this is a new
      // item or an existing one getting its photo/document replaced.
      let fileFields: { kind: "image" | "document"; mediaUrl: string; filename: string; mimeType: string } | null = null;
      if (file) {
        const { publicUrl } = await uploadAccountMedia("chat-media", file);
        fileFields = {
          kind: file.type.startsWith("image/") ? "image" : "document",
          mediaUrl: publicUrl,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
        };
      }

      if (isNew) {
        const res = await fetch("/api/ai/attachments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            ...fileFields,
            price: parsedPrice,
            currency: currency.trim() || null,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          toast.success(t("saveSuccessNew"));
          onOpenChange(false);
          onSaved();
        } else {
          toast.error(data.error ?? t("saveFailed"));
        }
      } else if (item) {
        const res = await fetch(`/api/ai/attachments/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            price: parsedPrice,
            currency: currency.trim() || null,
            ...fileFields,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          toast.success(t("saveSuccessUpdate"));
          onOpenChange(false);
          onSaved();
        } else {
          toast.error(data.error ?? t("saveFailed"));
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {item ? t("editAttachmentFormTitle") : t("addAttachment")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="catalog-item-name">{t("nameLabel")}</Label>
            <Input
              id="catalog-item-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              disabled={saving}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="catalog-item-description">{t("descriptionLabel")}</Label>
            <Textarea
              id="catalog-item-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={3}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">{t("descriptionHint")}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="catalog-item-price">{t("priceLabel")}</Label>
              <Input
                id="catalog-item-price"
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder={t("pricePlaceholder")}
                disabled={saving}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="catalog-item-currency">{t("currencyLabel")}</Label>
              <Input
                id="catalog-item-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                placeholder={t("currencyPlaceholder")}
                disabled={saving}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("priceHint")}</p>

          <div className="grid gap-2">
            <Label>{t("fileLabel")}</Label>
            {item?.kind === "image" && !file && (
              // eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URL preview
              <img
                src={item.mediaUrl}
                alt={item.name}
                className="h-32 w-full rounded-md object-cover"
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={onPickFile}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={saving}
            >
              <Upload className="mr-2 h-4 w-4" />
              {file ? file.name : item ? t("replaceFile") : t("chooseFile")}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("cancel")}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("saveAttachment")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
