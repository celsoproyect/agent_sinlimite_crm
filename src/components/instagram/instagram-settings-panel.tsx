"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  COMMENT_CATEGORIES,
  DEFAULT_FOLLOW_GATE_TEXT,
  MAX_DM_HOURLY_LIMIT,
  MAX_ICE_BREAKERS,
  MAX_MENU_ITEMS,
  type CommentAction,
  type InstagramSettings,
  type MenuItemKind,
} from "@/lib/instagram/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SELECT_CLASS, apiErrorText, type InstagramPageData } from "./instagram-utils";

const ACTIONS: (keyof CommentAction)[] = ["public", "dm", "notify", "hide"];
const MENU_KINDS: MenuItemKind[] = ["ai", "rule", "url"];

interface Props {
  data: InstagramPageData;
  settings: InstagramSettings;
  canManage: boolean;
  aiModuleOn: boolean;
  engagementModuleOn: boolean;
  onSaved: () => void;
}

// IA y automatización (migration 082): what the AI does with comments no
// rule caught, the story-mention thanks, the follow gate text, ice
// breakers, the fixed menu and the hourly DM limit.
export function InstagramSettingsPanel({ data, settings, canManage, aiModuleOn, engagementModuleOn, onSaved }: Props) {
  const t = useTranslations("Instagram");
  const locale = useLocale();
  const [form, setForm] = useState<InstagramSettings>(settings);
  const [saving, setSaving] = useState(false);
  const disabled = !canManage;

  const set = <K extends keyof InstagramSettings>(key: K, value: InstagramSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setAi = (patch: Partial<InstagramSettings["ai_comments"]>) =>
    setForm((f) => ({ ...f, ai_comments: { ...f.ai_comments, ...patch } }));
  const toggleAction = (cat: (typeof COMMENT_CATEGORIES)[number], action: keyof CommentAction) =>
    setForm((f) => ({
      ...f,
      ai_comments: {
        ...f.ai_comments,
        actions: { ...f.ai_comments.actions, [cat]: { ...f.ai_comments.actions[cat], [action]: !f.ai_comments.actions[cat][action] } },
      },
    }));

  async function save(resync = false) {
    setSaving(true);
    const res = await fetch("/api/instagram/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, resync }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      toast.error(res ? await apiErrorText(res, t) : t("errors.generic"));
      return;
    }
    const json = (await res.json()) as { settings: InstagramSettings };
    setForm(json.settings);
    if (json.settings.profile_error) toast.error(t("profileSyncFailed"));
    else toast.success(t("settingsSaved"));
    onSaved();
  }

  const fmt = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-DO", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Santo_Domingo",
  });
  const rules = data.rules.filter((r) => r.active || form.ice_breakers.some((i) => i.rule_id === r.id) || form.menu.some((m) => m.rule_id === r.id));

  return (
    <div className="space-y-6">
      {/* Comments AI */}
      <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{t("aiCommentsTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("aiCommentsHint")}</p>
          </div>
          <Switch
            checked={form.ai_comments.enabled}
            onCheckedChange={(v) => setAi({ enabled: v })}
            disabled={disabled || !aiModuleOn}
          />
        </div>
        {!aiModuleOn && <p className="text-xs text-destructive">{t("aiCommentsModuleOff")}</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-medium">{t("category")}</th>
                {ACTIONS.map((a) => (
                  <th key={a} className="px-2 py-1 text-center font-medium">
                    {t(`commentAction.${a}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMMENT_CATEGORIES.map((cat) => (
                <tr key={cat} className="border-t border-border">
                  <td className="py-1.5 pr-2 text-foreground">{t(`commentCategory.${cat}`)}</td>
                  {ACTIONS.map((a) => (
                    <td key={a} className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${t(`commentCategory.${cat}`)} · ${t(`commentAction.${a}`)}`}
                        checked={form.ai_comments.actions[cat][a]}
                        onChange={() => toggleAction(cat, a)}
                        disabled={disabled}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-1.5">
          <Label>{t("aiInstructions")}</Label>
          <Textarea
            rows={3}
            value={form.ai_comments.instructions}
            onChange={(e) => setAi({ instructions: e.target.value })}
            placeholder={t("aiInstructionsPlaceholder")}
            disabled={disabled}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("aiCommentsPerPost")}</p>
      </section>

      {/* Engagement */}
      <section className="space-y-4 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("engagementTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("engagementHint")}</p>
        </div>
        {!engagementModuleOn && <p className="text-xs text-destructive">{t("engagementModuleOff")}</p>}
        <div className="space-y-1.5">
          <Label>{t("mentionThanks")}</Label>
          <Textarea
            rows={2}
            value={form.mention_thanks}
            onChange={(e) => set("mention_thanks", e.target.value)}
            placeholder={t("mentionThanksPlaceholder")}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">{t("mentionThanksHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label>{t("followGateText")}</Label>
          <Textarea
            rows={2}
            value={form.follow_gate_text}
            onChange={(e) => set("follow_gate_text", e.target.value)}
            placeholder={DEFAULT_FOLLOW_GATE_TEXT}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">{t("followGateHint")}</p>
        </div>

        <div className="space-y-2">
          <Label>{t("iceBreakers")}</Label>
          <p className="text-xs text-muted-foreground">{t("iceBreakersHint")}</p>
          {form.ice_breakers.map((item, i) => (
            <div key={i} className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={item.question}
                maxLength={80}
                placeholder={t("iceBreakerQuestion")}
                onChange={(e) =>
                  set("ice_breakers", form.ice_breakers.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))
                }
                disabled={disabled}
              />
              <select
                className={`${SELECT_CLASS} sm:w-56`}
                value={item.rule_id ?? ""}
                onChange={(e) =>
                  set("ice_breakers", form.ice_breakers.map((x, j) => (j === i ? { ...x, rule_id: e.target.value || null } : x)))
                }
                disabled={disabled}
              >
                <option value="">{t("answeredByAi")}</option>
                {rules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || t("untitledRule")}
                  </option>
                ))}
              </select>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("remove")}
                onClick={() => set("ice_breakers", form.ice_breakers.filter((_, j) => j !== i))}
                disabled={disabled}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {canManage && form.ice_breakers.length < MAX_ICE_BREAKERS && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => set("ice_breakers", [...form.ice_breakers, { question: "", rule_id: null }])}
            >
              <Plus className="mr-1 h-4 w-4" />
              {t("addIceBreaker")}
            </Button>
          )}
        </div>

        <div className="space-y-2">
          <Label>{t("menu")}</Label>
          <p className="text-xs text-muted-foreground">{t("menuHint")}</p>
          {form.menu.map((item, i) => {
            const update = (patch: Partial<typeof item>) =>
              set("menu", form.menu.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={item.title}
                  maxLength={30}
                  placeholder={t("menuTitle")}
                  onChange={(e) => update({ title: e.target.value })}
                  disabled={disabled}
                />
                <select
                  className={`${SELECT_CLASS} sm:w-40`}
                  value={item.kind}
                  onChange={(e) => update({ kind: e.target.value as MenuItemKind })}
                  disabled={disabled}
                >
                  {MENU_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`menuKind.${k}`)}
                    </option>
                  ))}
                </select>
                {item.kind === "rule" && (
                  <select
                    className={`${SELECT_CLASS} sm:w-56`}
                    value={item.rule_id ?? ""}
                    onChange={(e) => update({ rule_id: e.target.value || null })}
                    disabled={disabled}
                  >
                    <option value="">{t("pickRule")}</option>
                    {rules.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name || t("untitledRule")}
                      </option>
                    ))}
                  </select>
                )}
                {item.kind === "url" && (
                  <Input
                    value={item.url ?? ""}
                    placeholder="https://"
                    onChange={(e) => update({ url: e.target.value })}
                    disabled={disabled}
                  />
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("remove")}
                  onClick={() => set("menu", form.menu.filter((_, j) => j !== i))}
                  disabled={disabled}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
          {canManage && form.menu.length < MAX_MENU_ITEMS && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => set("menu", [...form.menu, { title: "", kind: "ai", rule_id: null, url: null }])}
            >
              <Plus className="mr-1 h-4 w-4" />
              {t("addMenuItem")}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">{t("menuIncompleteHint")}</p>
        </div>

        <div className="space-y-1 text-xs">
          {form.profile_synced_at && (
            <p className="text-muted-foreground">{t("profileSyncedAt", { date: fmt.format(new Date(form.profile_synced_at)) })}</p>
          )}
          {form.profile_error && (
            <p className="break-words text-destructive">
              {form.profile_error === "not_connected" ? t("notConnected") : t("profileError", { error: form.profile_error })}
            </p>
          )}
          {canManage && (form.ice_breakers.length > 0 || form.menu.length > 0) && (
            <Button size="sm" variant="outline" onClick={() => void save(true)} disabled={saving}>
              <RefreshCw className="mr-1 h-4 w-4" />
              {t("resyncProfile")}
            </Button>
          )}
        </div>
      </section>

      {/* Queue */}
      <section className="space-y-2 rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">{t("dmLimitTitle")}</h2>
        <p className="text-xs text-muted-foreground">{t("dmLimitHint", { max: MAX_DM_HOURLY_LIMIT })}</p>
        <Input
          type="number"
          min={1}
          max={MAX_DM_HOURLY_LIMIT}
          className="w-32"
          value={form.dm_hourly_limit}
          onChange={(e) => set("dm_hourly_limit", Number(e.target.value) || 1)}
          disabled={disabled}
        />
      </section>

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t("save")}
          </Button>
        </div>
      )}
    </div>
  );
}
