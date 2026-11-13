"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Camera, Loader2, Plus, RefreshCw } from "lucide-react";
import { useModuleGate } from "@/hooks/use-module-gate";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import { isModuleEnabled } from "@/lib/modules";
import type { KeywordRule } from "@/lib/instagram/keywords";
import { Button } from "@/components/ui/button";
import { PostsPanel } from "@/components/instagram/posts-panel";
import { RulesList } from "@/components/instagram/rules-list";
import { RuleFormDialog } from "@/components/instagram/rule-form-dialog";
import { CommentsPanel } from "@/components/instagram/comments-panel";
import { apiErrorText, type InstagramPageData } from "@/components/instagram/instagram-utils";

type Tab = "posts" | "keywords" | "comments";

// Instagram (module `instagram`, comments behind `instagram_comments`,
// migration 079): posts and reels with their keyword rules ("comment
// PRECIO → public reply + private DM"), the general rules and the log of
// comments received.
export default function InstagramPage() {
  const t = useTranslations("Instagram");
  const { ready, loading: gateLoading } = useModuleGate("instagram");
  const { account } = useAuth();
  const isAdmin = useCan("edit-settings");
  const canReply = useCan("send-messages");

  const [tab, setTab] = useState<Tab>("posts");
  const [data, setData] = useState<InstagramPageData | null>(null);
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<{ rule: KeywordRule | null; mediaId?: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/instagram/posts").catch(() => null);
    if (res?.ok) {
      setData((await res.json()) as InstagramPageData);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads once the module gate opens
    void load();
  }, [ready, load]);

  async function sync() {
    setSyncing(true);
    const res = await fetch("/api/instagram/posts/sync", { method: "POST" }).catch(() => null);
    setSyncing(false);
    if (!res?.ok) {
      toast.error(res ? await apiErrorText(res, t) : t("errors.generic"));
      return;
    }
    const json = (await res.json()) as { count: number };
    toast.success(t("synced", { count: json.count }));
    void load();
  }

  if (gateLoading || !ready || (!data && !failed)) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        {t("errors.generic")}
      </div>
    );
  }

  const commentsOn = isModuleEnabled(account?.enabled_modules, "instagram_comments");
  const canManage = isAdmin && data.migrated;
  const generalRules = data.rules.filter((r) => !r.media_id);
  const tabs: Tab[] = ["posts", "keywords", "comments"];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Camera className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
          {data.username && <span className="text-xs text-muted-foreground">@{data.username}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && data.connected && (
            <Button size="sm" variant="outline" onClick={() => void sync()} disabled={syncing}>
              {syncing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}
              {t("sync")}
            </Button>
          )}
          {canManage && (
            <Button size="sm" onClick={() => setEditing({ rule: null })}>
              <Plus className="mr-1 h-4 w-4" />
              {t("newRule")}
            </Button>
          )}
        </div>
      </div>

      {!data.migrated && (
        <Notice>{t("errors.needs_migration")}</Notice>
      )}
      {data.migrated && !data.connected && (
        <Notice>
          {t("notConnected")}{" "}
          {isAdmin && (
            <Link href="/channels" className="text-primary hover:underline">
              {t("goToChannels")}
            </Link>
          )}
        </Notice>
      )}
      {data.migrated && !commentsOn && <Notice>{t("commentsModuleOff")}</Notice>}
      {data.syncError && <Notice>{t("syncFailed", { error: data.syncError })}</Notice>}

      <div className="flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1">
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              tab === key
                ? "min-h-9 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground sm:min-h-0"
                : "min-h-9 rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground sm:min-h-0"
            }
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>

      {tab === "posts" && (
        <PostsPanel
          data={data}
          canManage={canManage}
          onNewRule={(mediaId) => setEditing({ rule: null, mediaId })}
          onEdit={(rule) => setEditing({ rule })}
          onChanged={() => void load()}
        />
      )}
      {tab === "keywords" && (
        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-foreground">{t("generalRules")}</h2>
            <p className="text-xs text-muted-foreground">{t("generalRulesHint")}</p>
            <RulesList rules={generalRules} data={data} canManage={canManage} onEdit={(rule) => setEditing({ rule })} onChanged={() => void load()} />
          </section>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-foreground">{t("postRules")}</h2>
            <RulesList
              rules={data.rules.filter((r) => r.media_id)}
              data={data}
              canManage={canManage}
              onEdit={(rule) => setEditing({ rule })}
              onChanged={() => void load()}
            />
          </section>
        </div>
      )}
      {tab === "comments" && <CommentsPanel data={data} canReply={canReply && data.connected} />}

      <RuleFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        rule={editing?.rule ?? null}
        mediaId={editing?.mediaId}
        data={data}
        onSaved={() => void load()}
      />
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-border bg-card p-4 text-sm text-foreground shadow-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>{children}</div>
    </div>
  );
}
