"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Image as ImageIcon, Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { GatedButton } from "@/components/ui/gated-button";
import { Plus } from "lucide-react";
import { CatalogItemCard, type CatalogItem } from "@/components/catalog/catalog-item-card";
import { CatalogItemDialog } from "@/components/catalog/catalog-item-dialog";
import { useModuleGate } from "@/hooks/use-module-gate";

export default function CatalogPage() {
  const t = useTranslations("Settings.aiAttachments");
  const { accountId } = useAuth();
  const canEdit = useCan("edit-settings");
  const { ready: moduleReady, loading: moduleGateLoading } = useModuleGate("catalog");

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CatalogItem | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ai/attachments");
      const data = await res.json();
      if (res.ok) setItems(data.attachments ?? []);
      else toast.error(data.error ?? t("loadFailed"));
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId) return;
    void fetchItems();
  }, [accountId, fetchItems]);

  const openNew = () => {
    setEditingItem(null);
    setDialogOpen(true);
  };

  const openEdit = (item: CatalogItem) => {
    setEditingItem(item);
    setDialogOpen(true);
  };

  const remove = async (item: CatalogItem) => {
    if (!window.confirm(t("deleteConfirm", { name: item.name }))) return;
    try {
      const res = await fetch(`/api/ai/attachments/${item.id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success(t("removeSuccess"));
        setItems((list) => list.filter((x) => x.id !== item.id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? t("removeFailed"));
      }
    } catch {
      toast.error(t("removeFailed"));
    }
  };

  if (moduleGateLoading || !moduleReady) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ImageIcon className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <GatedButton canAct={canEdit} gateReason="manage the catalog" onClick={openNew}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t("addAttachment")}
        </GatedButton>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noAttachments")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <CatalogItemCard
              key={item.id}
              item={item}
              canEdit={canEdit}
              onEdit={openEdit}
              onDelete={remove}
            />
          ))}
        </div>
      )}

      <CatalogItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        item={editingItem}
        onSaved={fetchItems}
      />
    </div>
  );
}
