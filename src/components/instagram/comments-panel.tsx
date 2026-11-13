"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, MessageSquare, RefreshCw, Reply, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SELECT_CLASS, apiErrorText, postLabel, type InstagramCommentRow, type InstagramPageData } from "./instagram-utils";

const STATUSES = ["", "replied", "no_match", "error"] as const;
const PRIVATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Comentarios: every comment received and what the system did with it,
// with a manual public reply or private DM.
export function CommentsPanel({ data, canReply }: { data: InstagramPageData; canReply: boolean }) {
  const t = useTranslations("Instagram");
  const locale = useLocale();
  const [status, setStatus] = useState<string>("");
  const [comments, setComments] = useState<InstagramCommentRow[] | null>(null);
  const [replying, setReplying] = useState<{ id: string; mode: "public" | "private" } | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Captured when the list loads, so rendering stays pure.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async () => {
    const res = await fetch(`/api/instagram/comments${status ? `?status=${status}` : ""}`).catch(() => null);
    if (res?.ok) {
      const json = (await res.json()) as { comments: InstagramCommentRow[] };
      setComments(json.comments);
      setLoadedAt(Date.now());
    } else {
      setComments([]);
    }
  }, [status]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reloads when the filter changes
    void load();
  }, [load]);

  async function send() {
    if (!replying || !text.trim()) return;
    setSending(true);
    const res = await fetch(`/api/instagram/comments/${replying.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: replying.mode, text }),
    }).catch(() => null);
    setSending(false);
    if (!res?.ok) {
      toast.error(res ? await apiErrorText(res, t) : t("errors.generic"));
      return;
    }
    toast.success(t("replySent"));
    setReplying(null);
    setText("");
    void load();
  }

  const ruleName = (id: string | null) => data.rules.find((r) => r.id === id)?.name || (id ? t("untitledRule") : null);
  const fmt = new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-DO", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Santo_Domingo",
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${SELECT_CLASS} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`commentStatus.${s || "all"}`)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="mr-1 h-4 w-4" />
          {t("refresh")}
        </Button>
      </div>

      {comments === null ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : comments.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">{t("noComments")}</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => {
            const post = data.posts.find((p) => p.media_id === c.media_id);
            const dmDone = ["sent", "awaiting_tap", "delivered", "manual"].includes(c.dm_status ?? "");
            const canPrivate = !dmDone && loadedAt - new Date(c.created_at).getTime() < PRIVATE_WINDOW_MS;
            const rule = ruleName(c.rule_id);
            return (
              <li key={c.id} className="space-y-2 rounded-lg border border-border bg-card p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm text-foreground">
                    <span className="font-medium">@{c.username ?? "—"}</span> <span className="break-words">{c.text}</span>
                  </p>
                  <span className="text-xs text-muted-foreground">{fmt.format(new Date(c.created_at))}</span>
                </div>
                <p className="break-words text-xs text-muted-foreground">
                  {[
                    post ? postLabel(post, t) : null,
                    t(`commentStatus.${["replied", "no_match", "skipped", "error", "processing"].includes(c.status) ? c.status : "all"}`),
                    rule ? t("byRule", { rule }) : null,
                    c.dm_status ? t(`dmStatus.${c.dm_status}`) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {c.public_reply_text && <p className="text-xs text-foreground">↳ {c.public_reply_text}</p>}
                {c.dm_error && <p className="break-words text-xs text-destructive">{c.dm_error}</p>}
                <div className="flex flex-wrap gap-2">
                  {canReply && (
                    <Button size="sm" variant="outline" onClick={() => setReplying({ id: c.id, mode: "public" })}>
                      <Reply className="mr-1 h-4 w-4" />
                      {t("replyPublic")}
                    </Button>
                  )}
                  {canReply && canPrivate && (
                    <Button size="sm" variant="outline" onClick={() => setReplying({ id: c.id, mode: "private" })}>
                      <Send className="mr-1 h-4 w-4" />
                      {t("replyPrivate")}
                    </Button>
                  )}
                  {c.conversation_id && (
                    <Link
                      href={`/inbox?c=${c.conversation_id}`}
                      className="inline-flex items-center rounded-md px-2 py-1 text-sm text-primary hover:underline"
                    >
                      <MessageSquare className="mr-1 h-4 w-4" />
                      {t("openChat")}
                    </Link>
                  )}
                </div>
                {replying?.id === c.id && (
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={replying.mode === "public" ? t("publicReplyPlaceholder") : t("privateReplyPlaceholder")}
                      onKeyDown={(e) => e.key === "Enter" && void send()}
                    />
                    <Button size="sm" onClick={() => void send()} disabled={sending || !text.trim()}>
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : t("send")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setReplying(null)}>
                      {t("cancel")}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
