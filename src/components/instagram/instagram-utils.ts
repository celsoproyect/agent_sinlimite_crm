import type { useTranslations } from "next-intl";
import type { KeywordRule } from "@/lib/instagram/keywords";

// Shared bits of the /instagram page (phase 2, migration 079).

export type InstagramT = ReturnType<typeof useTranslations>;

export interface InstagramPost {
  media_id: string;
  caption: string | null;
  media_type: string | null;
  media_product_type: string | null;
  permalink: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  posted_at: string | null;
}

export interface InstagramCommentRow {
  id: string;
  comment_id: string;
  media_id: string | null;
  parent_id: string | null;
  username: string | null;
  text: string | null;
  rule_id: string | null;
  status: string;
  public_reply_text: string | null;
  dm_status: string | null;
  dm_error: string | null;
  conversation_id: string | null;
  created_at: string;
}

/** GET /api/instagram/posts. */
export interface InstagramPageData {
  migrated: boolean;
  /** Migration 080 applied (several posts, files, automations, examples). */
  v2?: boolean;
  connected: boolean;
  username?: string | null;
  syncError?: string | null;
  posts: InstagramPost[];
  rules: KeywordRule[];
  catalog: { id: string; name: string; kind: string }[];
  tags: { id: string; name: string; color?: string | null }[];
  automations: { id: string; name: string; trigger_type: string; is_active: boolean }[];
}

/**
 * Instagram draws quick-reply buttons itself and lets no one color them,
 * so the "color" is a colored emoji at the start of the label.
 */
export const BUTTON_COLORS = ["", "🟢", "🔵", "🔴", "🟡", "🟣", "🟠", "⚫", "⚪"] as const;

/** Splits a saved label into its color emoji and its text. */
export function buttonColorOf(label: string): { color: string; label: string } {
  for (const c of BUTTON_COLORS) {
    if (c && label.startsWith(c)) return { color: c, label: label.slice(c.length).trimStart() };
  }
  return { color: "", label };
}

/** The label with `color` in front, replacing any color it already had. */
export function withButtonColor(color: string, label: string): string {
  const text = buttonColorOf(label.trim()).label.trim();
  return (color ? `${color} ${text}` : text).slice(0, 20);
}

/** Which posts a rule covers, for its card. */
export function rulePostsLabel(rule: KeywordRule, posts: InstagramPost[], t: InstagramT): string {
  if (rule.media_ids.length === 0) return t("generalRule");
  if (rule.media_ids.length === 1) return postLabel(posts.find((p) => p.media_id === rule.media_ids[0]), t);
  return t("postsCount", { count: rule.media_ids.length });
}

export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

/** The picture to show for a post (a video's thumbnail). */
export function postImage(p: InstagramPost): string | null {
  return p.media_type === "VIDEO" ? p.thumbnail_url ?? null : p.media_url ?? p.thumbnail_url ?? null;
}

/** A post's short label: caption start, else its kind. */
export function postLabel(p: InstagramPost | undefined, t: InstagramT): string {
  if (!p) return t("generalRule");
  const caption = p.caption?.replace(/\s+/g, " ").trim();
  if (caption) return caption.length > 60 ? `${caption.slice(0, 60)}…` : caption;
  return p.media_product_type === "REELS" ? t("reel") : t("post");
}

const KNOWN_ERRORS = new Set([
  "needs_migration",
  "module_disabled",
  "not_connected",
  "keyword_conflict",
  "keywords_required",
  "reply_required",
  "catalog_needs_button",
  "file_needs_button",
  "automation_needs_button",
  "posts_required",
  "invalid_file",
  "too_many_posts",
  "invalid_link",
  "already_messaged",
  "too_old",
]);

export async function apiErrorText(res: Response, t: InstagramT): Promise<string> {
  const json = (await res.json().catch(() => null)) as
    | { error?: string; conflicts?: { keyword: string; ruleName: string }[] }
    | null;
  const code = json?.error ?? "";
  if (code === "keyword_conflict" && json?.conflicts?.length) {
    const c = json.conflicts[0];
    return t("errors.keyword_conflict", { keyword: c.keyword === "*" ? t("anyComment") : c.keyword, rule: c.ruleName || "—" });
  }
  if (KNOWN_ERRORS.has(code)) return t(`errors.${code}`);
  if (res.status === 403) return t("errors.forbidden");
  return code || t("errors.generic");
}
