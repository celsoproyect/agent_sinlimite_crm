"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { MEDIA_MAX_BYTES_BY_KIND, uploadAccountMedia } from "@/lib/storage/upload-media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SELECT_CLASS, apiErrorText, type InstagramPageData, type InstagramPost } from "./instagram-utils";

interface Props {
  post: InstagramPost | null;
  data: InstagramPageData;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

// The offer of one post (migration 082, module instagram_offers): what
// the DM agent and the comments AI say when a customer comes from it.
export function PostOfferDialog({ post, data, onOpenChange, onSaved }: Props) {
  const t = useTranslations("Instagram");
  return (
    <Dialog open={!!post} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("postOffer")}</DialogTitle>
        </DialogHeader>
        {post && <OfferForm key={post.media_id} post={post} data={data} onCancel={() => onOpenChange(false)} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function OfferForm({
  post,
  data,
  onCancel,
  onSaved,
}: {
  post: InstagramPost;
  data: InstagramPageData;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Instagram");
  const [text, setText] = useState(post.offer_text ?? "");
  const [link, setLink] = useState(post.offer_link_url ?? "");
  const [catalogItem, setCatalogItem] = useState(post.offer_catalog_item_id ?? "");
  const [file, setFile] = useState<{ url: string; name: string } | null>(
    post.offer_media_url ? { url: post.offer_media_url, name: post.offer_media_name ?? "" } : null,
  );
  const [expiresOn, setExpiresOn] = useState(post.offer_expires_on ?? "");
  const [aiOn, setAiOn] = useState(post.ai_comments_enabled ?? true);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  async function upload(picked: File | undefined) {
    if (!picked) return;
    const kind = picked.type.startsWith("image/") ? "image" : "document";
    if (kind === "document" && picked.type !== "application/pdf") {
      toast.error(t("fileTypeError"));
      return;
    }
    if (picked.size > MEDIA_MAX_BYTES_BY_KIND[kind]) {
      toast.error(t("fileTooBig", { mb: Math.round(MEDIA_MAX_BYTES_BY_KIND[kind] / 1024 / 1024) }));
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("chat-media", picked);
      setFile({ url: publicUrl, name: picked.name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/instagram/posts/${post.media_id}/offer`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offer_text: text,
        offer_link_url: link || null,
        offer_catalog_item_id: catalogItem || null,
        offer_media_url: file?.url ?? null,
        offer_media_name: file?.name || null,
        offer_expires_on: expiresOn || null,
        ai_comments_enabled: aiOn,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      toast.error(res ? await apiErrorText(res, t) : t("errors.generic"));
      return;
    }
    toast.success(t("offerSaved"));
    onSaved();
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("postOfferHint")}</p>
      <div className="space-y-1.5">
        <Label>{t("offerText")}</Label>
        <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("offerTextPlaceholder")} />
      </div>
      <div className="space-y-1.5">
        <Label>{t("dmLink")}</Label>
        <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />
      </div>
      <div className="space-y-1.5">
        <Label>{t("catalogItem")}</Label>
        <select className={SELECT_CLASS} value={catalogItem} onChange={(e) => setCatalogItem(e.target.value)}>
          <option value="">{t("none")}</option>
          {data.catalog.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label>{t("ruleFile")}</Label>
        {file ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm">
            <FileText className="h-4 w-4 shrink-0" />
            <a href={file.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-primary hover:underline">
              {file.name || file.url}
            </a>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setFile(null)} aria-label={t("removeFile")}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-sm text-muted-foreground hover:border-primary">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            {t("uploadFile")}
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
      <div className="space-y-1.5">
        <Label>{t("offerExpiresOn")}</Label>
        <Input type="date" className="w-44" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        <p className="text-xs text-muted-foreground">{t("offerExpiresHint")}</p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label className="leading-snug">{t("postAiComments")}</Label>
        <Switch checked={aiOn} onCheckedChange={setAiOn} />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
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
