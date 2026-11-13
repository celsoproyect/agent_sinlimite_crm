"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { KeywordRule } from "@/lib/instagram/keywords";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SELECT_CLASS, apiErrorText, postLabel, type InstagramPageData } from "./instagram-utils";

interface RuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = new rule. */
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
          <DialogTitle className="text-popover-foreground">{rule ? t("editRule") : t("newRule")}</DialogTitle>
        </DialogHeader>
        {open && (
          <RuleForm
            key={rule?.id ?? `new-${mediaId ?? ""}`}
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
  const [media, setMedia] = useState(rule ? rule.media_id ?? "" : mediaId);
  const [matchAny, setMatchAny] = useState(rule?.match_any ?? false);
  const [keywords, setKeywords] = useState((rule?.keywords ?? []).join(", "));
  const [publicReplies, setPublicReplies] = useState((rule?.public_replies ?? []).join("\n"));
  const [useButton, setUseButton] = useState(rule ? !!rule.dm_button_label : true);
  const [opening, setOpening] = useState(rule?.dm_opening ?? "");
  const [buttonLabel, setButtonLabel] = useState(rule?.dm_button_label ?? t("defaultButton"));
  const [dmText, setDmText] = useState(rule?.dm_text ?? "");
  const [link, setLink] = useState(rule?.dm_link_url ?? "");
  const [catalogItem, setCatalogItem] = useState(rule?.catalog_item_id ?? "");
  const [tag, setTag] = useState(rule?.tag_id ?? "");
  const [oncePerUser, setOncePerUser] = useState(rule?.once_per_user ?? true);
  const [active, setActive] = useState(rule?.active ?? true);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const body = {
      name,
      media_id: media || null,
      match_any: matchAny,
      keywords: matchAny ? [] : keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean),
      public_replies: lines(publicReplies),
      dm_opening: useButton ? opening : null,
      dm_button_label: useButton ? buttonLabel : null,
      dm_text: dmText,
      dm_link_url: link || null,
      catalog_item_id: catalogItem || null,
      tag_id: tag || null,
      once_per_user: oncePerUser,
      active,
    };
    const res = await fetch(rule ? `/api/instagram/rules/${rule.id}` : "/api/instagram/rules", {
      method: rule ? "PATCH" : "POST",
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
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t("ruleName")}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ruleNamePlaceholder")} maxLength={80} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("rulePost")}</Label>
          <select className={SELECT_CLASS} value={media} onChange={(e) => setMedia(e.target.value)}>
            <option value="">{t("generalRule")}</option>
            {data.posts.map((p) => (
              <option key={p.media_id} value={p.media_id}>
                {postLabel(p, t)}
              </option>
            ))}
          </select>
        </div>
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
              <Input value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} maxLength={20} />
            </div>
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
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t("save")}
        </Button>
      </DialogFooter>
    </div>
  );
}
