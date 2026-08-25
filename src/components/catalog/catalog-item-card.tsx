"use client";

import { useTranslations } from "next-intl";
import { FileText, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  kind: "image" | "document";
  mediaUrl: string;
  filename: string;
  mimeType: string;
  price?: number;
  currency?: string;
  updatedAt: string;
}

interface CatalogItemCardProps {
  item: CatalogItem;
  canEdit: boolean;
  onEdit: (item: CatalogItem) => void;
  onDelete: (item: CatalogItem) => void;
}

export function CatalogItemCard({ item, canEdit, onEdit, onDelete }: CatalogItemCardProps) {
  const t = useTranslations("Settings.aiAttachments");

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {item.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URLs, not a local/optimizable asset
          <img
            src={item.mediaUrl}
            alt={item.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <FileText className="h-10 w-10 text-muted-foreground" />
          </div>
        )}
        {canEdit && (
          <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button
              variant="secondary"
              size="sm"
              className="h-7 w-7 p-0 shadow"
              onClick={() => onEdit(item)}
              title={t("editAttachment")}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 w-7 p-0 text-destructive shadow hover:text-destructive"
              onClick={() => onDelete(item)}
              title={t("deleteAttachment")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">{item.name}</span>
          {item.price != null && (
            <span className="shrink-0 text-sm font-semibold text-primary">
              {item.currency ?? ""} {item.price}
            </span>
          )}
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
      </div>
    </div>
  );
}
