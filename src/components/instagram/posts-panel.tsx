"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Film, Plus } from "lucide-react";
import type { KeywordRule } from "@/lib/instagram/keywords";
import { Button } from "@/components/ui/button";
import { RulesList } from "./rules-list";
import { postImage, postLabel, type InstagramPageData, type InstagramPost } from "./instagram-utils";

interface PostsPanelProps {
  data: InstagramPageData;
  canManage: boolean;
  onNewRule: (mediaId: string) => void;
  onEdit: (rule: KeywordRule) => void;
  onDuplicate: (rule: KeywordRule) => void;
  onChanged: () => void;
}

// Publicaciones: the account's posts and reels, each with its own keyword
// rules ("comment PRECIO on this reel").
export function PostsPanel({ data, canManage, onNewRule, onEdit, onDuplicate, onChanged }: PostsPanelProps) {
  const t = useTranslations("Instagram");
  const [selected, setSelected] = useState<string | null>(null);

  if (data.posts.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        {data.connected ? t("noPosts") : t("notConnected")}
      </div>
    );
  }

  const current = data.posts.find((p) => p.media_id === selected) ?? null;

  return (
    <div className="space-y-4">
      {current && (
        <PostDetail
          post={current}
          rules={data.rules.filter((r) => r.media_ids.includes(current.media_id))}
          data={data}
          canManage={canManage}
          onClose={() => setSelected(null)}
          onNewRule={() => onNewRule(current.media_id)}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onChanged={onChanged}
        />
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {data.posts.map((p) => {
          const count = data.rules.filter((r) => r.media_ids.includes(p.media_id)).length;
          const image = postImage(p);
          return (
            <button
              key={p.media_id}
              type="button"
              onClick={() => setSelected(p.media_id === selected ? null : p.media_id)}
              className={`overflow-hidden rounded-xl border bg-card text-left shadow-sm transition hover:border-primary ${
                p.media_id === selected ? "border-primary ring-1 ring-primary" : "border-border"
              }`}
            >
              <div className="relative aspect-square bg-muted">
                {image && (
                  // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN URLs
                  <img src={image} alt="" className="h-full w-full object-cover" loading="lazy" />
                )}
                {p.media_product_type === "REELS" && (
                  <Film className="absolute right-2 top-2 h-4 w-4 text-white drop-shadow" />
                )}
                {count > 0 && (
                  <span className="absolute bottom-2 left-2 rounded bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                    {t("rulesCount", { count })}
                  </span>
                )}
              </div>
              <p className="line-clamp-2 p-2 text-xs text-muted-foreground">{postLabel(p, t)}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PostDetail({
  post,
  rules,
  data,
  canManage,
  onClose,
  onNewRule,
  onEdit,
  onDuplicate,
  onChanged,
}: {
  post: InstagramPost;
  rules: KeywordRule[];
  data: InstagramPageData;
  canManage: boolean;
  onClose: () => void;
  onNewRule: () => void;
  onEdit: (rule: KeywordRule) => void;
  onDuplicate: (rule: KeywordRule) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("Instagram");
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-line break-words text-sm text-foreground">{post.caption || postLabel(post, t)}</p>
          {post.permalink && (
            <a
              href={post.permalink}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {t("openOnInstagram")}
            </a>
          )}
        </div>
        <div className="flex gap-2">
          {canManage && (
            <Button size="sm" onClick={onNewRule}>
              <Plus className="mr-1 h-4 w-4" />
              {t("newRule")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
      <RulesList rules={rules} data={data} canManage={canManage} hidePost onEdit={onEdit} onDuplicate={onDuplicate} onChanged={onChanged} />
      {rules.length === 0 && data.rules.some((r) => r.media_ids.length === 0 && r.active) && (
        <p className="text-xs text-muted-foreground">{t("generalRulesApply")}</p>
      )}
    </div>
  );
}
