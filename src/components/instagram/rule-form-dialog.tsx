"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, FileText, Image as ImageIcon, Loader2, Paperclip, X } from "lucide-react";
import { RULE_TRIGGERS, type KeywordRule, type RuleMediaKind, type RuleTrigger } from "@/lib/instagram/keywords";
import { MEDIA_MAX_BYTES_BY_KIND, uploadAccountMedia } from "@/lib/storage/upload-media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BUTTON_COLORS, SELECT_CLASS, apiErrorText, buttonColorOf, postImage, postLabel, withButtonColor, type InstagramPageData } from "./instagram-utils";

interface RuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = new rule; a rule with id "" = a duplicate to save as new. */
  rule: KeywordRule | null;
  /** Preselected post for a new rule ("" = general). */
  mediaId?: string;
  data: InstagramPageData;
  onSaved: () => void;
}

export function RuleFormDialog({ open, onOpenChange, rule, mediaId, data, onSaved }: RuleFormDialogProps) {
  const t = useTranslations("Instagram");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {rule?.id ? t("editRule") : rule ? t("duplicateRule") : t("newRule")}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <RuleForm
            key={rule ? rule.id || `dup-${rule.name}` : `new-${mediaId ?? ""}`}
            rule={rule}
            mediaId={mediaId ?? ""}
            data={data}
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

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function RuleForm({
  rule,
  mediaId,
  data,
  onCancel,
  onSaved,
}: {
  rule: KeywordRule | null;
  mediaId: string;
  data: InstagramPageData;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("Instagram");
  const [name, setName] = useState(rule?.name ?? "");
  const [mediaIds, setMediaIds] = useState<string[]>(rule ? rule.media_ids : mediaId ? [mediaId] : []);
  const [allPosts, setAllPosts] = useState(rule ? rule.media_ids.length === 0 : !mediaId);
  const [matchAny, setMatchAny] = useState(rule?.match_any ?? false);
  const [keywords, setKeywords] = useState((rule?.keywords ?? []).join(", "));
  const [publicReplies, setPublicReplies] = useState((rule?.public_replies ?? []).join("\n"));
  const [useButton, setUseButton] = useState(rule ? !!rule.dm_button_label : true);
  const [opening, setOpening] = useState(rule?.dm_opening ?? "");
  const initialButton = buttonColorOf(rule?.dm_button_label ?? t("defaultButton"));
  const [buttonColor, setButtonColor] = useState(initialButton.color);
  const [buttonLabel, setButtonLabel] = useState(initialButton.label);
  const [dmText, setDmText] = useState(rule?.dm_text ?? "");
  const [link, setLink] = useState(rule?.dm_link_url ?? "");
  const [catalogItem, setCatalogItem] = useState(rule?.catalog_item_id ?? "");
  const [file, setFile] = useState<{ url: string; kind: RuleMediaKind; name: string } | null>(
    rule?.dm_media_url ? { url: rule.dm_media_url, kind: rule.dm_media_kind ?? "document", name: rule.dm_media_name ?? "" } : null,
  );
  const [uploading, setUploading] = useState(false);
  const [automation, setAutomation] = useState(rule?.automation_id ?? "");
  const [tag, setTag] = useState(rule?.tag_id ?? "");
  const [oncePerUser, setOncePerUser] = useState(rule?.once_per_user ?? true);
  const [active, setActive] = useState(rule?.active ?? true);
  const [triggers, setTriggers] = useState<RuleTrigger[]>(rule?.triggers?.length ? rule.triggers : ["comments"]);
  const [requireFollow, setRequireFollow] = useState(rule?.require_follow ?? false);
  const [saving, setSaving] = useState(false);

  async function upload(picked: File | undefined) {
    if (!picked) return;
    const kind: RuleMediaKind = picked.type.startsWith("image/") ? "image" : "document";
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
      setFile({ url: publicUrl, kind, name: picked.name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setUploading(false);
    }
  }

  function togglePost(id: string) {
    setMediaIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function save() {
    if (!allPosts && mediaIds.length === 0) {
      toast.error(t("errors.posts_required"));
      return;
    }
    if (data.v3 && triggers.length === 0) {
      toast.error(t("errors.triggers_required"));
      return;
    }
    setSaving(true);
    const body: Record<string, unknown> = {
      name,
      media_ids: allPosts ? [] : mediaIds,
      match_any: matchAny,
      keywords: matchAny ? [] : keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean),
      public_replies: lines(publicReplies),
      dm_opening: useButton ? opening : null,
      dm_button_label: useButton ? withButtonColor(buttonColor, buttonLabel) : null,
      dm_text: dmText,
      dm_link_url: link || null,
      catalog_item_id: catalogItem || null,
      dm_media_url: file?.url ?? null,
      dm_media_kind: file?.kind ?? null,
      dm_media_name: file?.name || null,
      automation_id: automation || null,
      tag_id: tag || null,
      once_per_user: oncePerUser,
      active,
    };
    // Migration 082: where the rule listens and the follow gate.
    if (data.v3) {
      body.triggers = triggers;
      body.require_follow = requireFollow;
    }
    const res = await fetch(rule?.id ? `/api/instagram/rules/${rule.id}` : "/api/instagram/rules", {
      method: rule?.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSaving(false);
    if (!res) {
      toast.error(t("errors.generic"));
      return;
    }
    if (!res.ok) {
      toast.error(await apiErrorText(res, t));
      return;
    }
    toast.success(t("ruleSaved"));
    onSaved();
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t("ruleName")}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ruleNamePlaceholder")} maxLength={80} />
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="leading-snug">{t("allPosts")}</Label>
          <Switch checked={allPosts} onCheckedChange={setAllPosts} />
        </div>
        {allPosts ? (
          <p className="text-xs text-muted-foreground">{t("allPostsHint")}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{t("pickPostsHint", { count: mediaIds.length })}</p>
            {data.posts.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noPosts")}</p>
            ) : (
              <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
                {data.posts.map((p) => {
                  const on = mediaIds.includes(p.media_id);
                  const image = postImage(p);
                  return (
                    <button
                      key={p.media_id}
                      type="button"
                      onClick={() => togglePost(p.media_id)}
                      title={postLabel(p, t)}
                      aria-pressed={on}
                      className={`relative overflow-hidden rounded-lg border text-left ${
                        on ? "border-primary ring-2 ring-primary" : "border-border opacity-80 hover:opacity-100"
                      }`}
                    >
                      <div className="aspect-square bg-muted">
                        {image && (
                          // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN URLs
                          <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
                        )}
                      </div>
                      {on && (
                        <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                          <Check className="h-3 w-3" />
                        </span>
                      )}
                      <p className="line-clamp-1 px-1 py-0.5 text-[11px] text-muted-foreground">{postLabel(p, t)}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="leading-snug">{t("matchAny")}</Label>
          <Switch checked={matchAny} onCheckedChange={setMatchAny} />
        </div>
        {!matchAny && (
          <div className="space-y-1.5">
            <Label>{t("keywords")}</Label>
            <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder={t("keywordsPlaceholder")} />
            <p className="text-xs text-muted-foreground">{t("keywordsHint")}</p>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>{t("publicReplies")}</Label>
        <Textarea
          value={publicReplies}
          onChange={(e) => setPublicReplies(e.target.value)}
          rows={3}
          placeholder={t("publicRepliesPlaceholder")}
        />
        <p className="text-xs text-muted-foreground">{t("publicRepliesHint")}</p>
      </div>

      <div className="space-y-3 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-foreground">{t("privateDm")}</p>
        <div className="flex items-center justify-between gap-3">
          <Label className="leading-snug">{t("useButton")}</Label>
          <Switch checked={useButton} onCheckedChange={setUseButton} />
        </div>
        <p className="text-xs text-muted-foreground">{useButton ? t("useButtonHint") : t("noButtonHint")}</p>
        {useButton && (
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <div className="space-y-1.5">
              <Label>{t("dmOpening")}</Label>
              <Textarea value={opening} onChange={(e) => setOpening(e.target.value)} rows={2} placeholder={t("dmOpeningPlaceholder")} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("buttonLabel")}</Label>
              <Input value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} maxLength={buttonColor ? 17 : 20} />
            </div>
          </div>
        )}
        {useButton && (
          <div className="space-y-1.5">
            <Label>{t("buttonColor")}</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {BUTTON_COLORS.map((c) => (
                <button
                  key={c || "none"}
                  type="button"
                  onClick={() => setButtonColor(c)}
                  aria-pressed={buttonColor === c}
                  className={`flex h-8 min-w-8 items-center justify-center rounded-md border px-1.5 text-base ${
                    buttonColor === c ? "border-primary ring-1 ring-primary" : "border-border"
                  }`}
                >
                  {c || <span className="text-xs text-muted-foreground">{t("noColor")}</span>}
                </button>
              ))}
              <span className="ml-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground">
                {withButtonColor(buttonColor, buttonLabel || t("defaultButton"))}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{t("buttonColorHint")}</p>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>{t("dmText")}</Label>
          <Textarea value={dmText} onChange={(e) => setDmText(e.target.value)} rows={4} placeholder={t("dmTextPlaceholder")} />
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
          {catalogItem && !useButton && <p className="text-xs text-destructive">{t("errors.catalog_needs_button")}</p>}
        </div>
        <div className="space-y-1.5">
          <Label>{t("ruleFile")}</Label>
          {file ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm">
              {file.kind === "image" ? <ImageIcon className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
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
          <p className="text-xs text-muted-foreground">{t("ruleFileHint")}</p>
          {file && !useButton && <p className="text-xs text-destructive">{t("errors.file_needs_button")}</p>}
        </div>
        <div className="space-y-1.5">
          <Label>{t("ruleAutomation")}</Label>
          <select className={SELECT_CLASS} value={automation} onChange={(e) => setAutomation(e.target.value)}>
            <option value="">{t("none")}</option>
            {[...data.automations]
              .sort((a, b) => Number(b.trigger_type === "instagram_rule") - Number(a.trigger_type === "instagram_rule"))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.is_active ? "" : ` (${t("inactive")})`}
                </option>
              ))}
          </select>
          <p className="text-xs text-muted-foreground">{t("ruleAutomationHint")}</p>
          {automation && !useButton && <p className="text-xs text-destructive">{t("errors.automation_needs_button")}</p>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t("tag")}</Label>
          <select className={SELECT_CLASS} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">{t("none")}</option>
            {data.tags.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
        {data.v3 && (
          <div className="space-y-2">
            <Label>{t("ruleTriggers")}</Label>
            <div className="flex flex-wrap gap-3">
              {RULE_TRIGGERS.map((key) => (
                <label key={key} className="flex items-center gap-1.5 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={triggers.includes(key)}
                    onChange={() =>
                      setTriggers((list) => (list.includes(key) ? list.filter((x) => x !== key) : [...list, key]))
                    }
                  />
                  {t(`ruleTrigger.${key}`)}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("ruleTriggersHint")}</p>
            <div className="flex items-center justify-between gap-3 pt-1">
              <Label className="leading-snug">{t("requireFollow")}</Label>
              <Switch checked={requireFollow} onCheckedChange={setRequireFollow} />
            </div>
            {requireFollow && <p className="text-xs text-muted-foreground">{t("requireFollowHint")}</p>}
          </div>
        )}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between gap-3">
            <Label className="leading-snug">{t("oncePerUser")}</Label>
            <Switch checked={oncePerUser} onCheckedChange={setOncePerUser} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="leading-snug">{t("active")}</Label>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>
        </div>
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
