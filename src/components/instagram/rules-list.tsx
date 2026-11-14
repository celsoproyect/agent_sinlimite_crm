"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Pencil, Trash2 } from "lucide-react";
import type { KeywordRule } from "@/lib/instagram/keywords";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { apiErrorText, rulePostsLabel, type InstagramPageData } from "./instagram-utils";

interface RulesListProps {
  rules: KeywordRule[];
  data: InstagramPageData;
  canManage: boolean;
  /** Hide the post name (inside a post's own card). */
  hidePost?: boolean;
  onEdit: (rule: KeywordRule) => void;
  /** Opens a copy of the rule as a new one. */
  onDuplicate: (rule: KeywordRule) => void;
  onChanged: () => void;
}

export function RulesList({ rules, data, canManage, hidePost, onEdit, onDuplicate, onChanged }: RulesListProps) {
  const t = useTranslations("Instagram");
  const [busy, setBusy] = useState<string | null>(null);

  async function patch(rule: KeywordRule, body: Record<string, unknown>, method: "PATCH" | "DELETE" = "PATCH") {
    setBusy(rule.id);
    const res = await fetch(`/api/instagram/rules/${rule.id}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "PATCH" ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      toast.error(res ? await apiErrorText(res, t) : t("errors.generic"));
      return;
    }
    onChanged();
  }

  if (rules.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noRules")}</p>;
  }

  return (
    <ul className="space-y-2">
      {rules.map((rule) => {
        const automation = rule.automation_id ? data.automations.find((a) => a.id === rule.automation_id) : null;
        return (
          <li key={rule.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card p-3">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium text-foreground">
                {rule.name || t("untitledRule")}
                {rule.is_sample && (
                  <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-600">
                    {t("sampleBadge")}
                  </span>
                )}
              </p>
              <div className="flex flex-wrap gap-1">
                {rule.match_any ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">{t("anyComment")}</span>
                ) : (
                  rule.keywords.map((k) => (
                    <span key={k} className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                      {k}
                    </span>
                  ))
                )}
              </div>
              {(!hidePost || rule.media_ids.length > 1) && (
                <p className="break-words text-xs text-muted-foreground">{rulePostsLabel(rule, data.posts, t)}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {[
                  rule.public_replies.length > 0 ? t("summaryPublic", { count: rule.public_replies.length }) : null,
                  rule.dm_button_label ? t("summaryButton", { label: rule.dm_button_label }) : null,
                  rule.dm_text || rule.dm_link_url ? t("summaryDm") : null,
                  rule.catalog_item_id ? t("summaryCatalog") : null,
                  rule.dm_media_url ? (rule.dm_media_kind === "image" ? t("summaryImage") : t("summaryPdf")) : null,
                  automation ? t("summaryAutomation", { name: automation.name }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {canManage && (
              <div className="flex items-center gap-1">
                <Switch
                  checked={rule.active}
                  disabled={busy === rule.id}
                  onCheckedChange={(v) => void patch(rule, { active: v })}
                  aria-label={t("active")}
                />
                <Button size="icon" variant="ghost" onClick={() => onEdit(rule)} aria-label={t("editRule")} title={t("editRule")}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => onDuplicate(rule)} aria-label={t("duplicate")} title={t("duplicate")}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy === rule.id}
                  aria-label={t("deleteRule")}
                  onClick={() => {
                    if (confirm(t("deleteRuleConfirm"))) void patch(rule, {}, "DELETE");
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
