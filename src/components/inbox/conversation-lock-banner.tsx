"use client";

import { useState, useCallback } from "react";
import { Lock, LockOpen, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";

interface ConversationLockBannerProps {
  conversationId: string;
  /** `conversations.assigned_agent_id` — also the lock holder. */
  assignedAgentId: string | null;
  /** Display name for the current holder, when it isn't the acting agent. */
  assignedAgentName?: string | null;
  currentUserId?: string | null;
  /** From `useAuth().canOverrideLock` — admin/owner can release someone
   *  else's claim; a regular agent can only claim or release their own. */
  canOverrideLock: boolean;
  /** Called after a successful claim/release so the parent can patch its
   *  local conversation state (the realtime UPDATE also arrives, but this
   *  keeps the banner instant). */
  onChange?: (assignedAgentId: string | null) => void;
}

/**
 * Real ownership banner for a conversation: claim an unassigned thread,
 * see who holds it, and release it. The DB-side `enforce_conversation_lock`
 * trigger (migration 046) is what actually stops another agent from
 * stealing a claim — this banner just surfaces that state and offers the
 * one action the trigger will allow.
 */
export function ConversationLockBanner({
  conversationId,
  assignedAgentId,
  assignedAgentName,
  currentUserId,
  canOverrideLock,
  onChange,
}: ConversationLockBannerProps) {
  const t = useTranslations("Inbox.lockBanner");
  const [busy, setBusy] = useState(false);

  const setAssignee = useCallback(
    async (agentId: string | null, errorKey: "claimError" | "releaseError") => {
      setBusy(true);
      try {
        const supabase = createClient();
        const { error } = await supabase
          .from("conversations")
          .update({
            assigned_agent_id: agentId,
            locked_at: agentId ? new Date().toISOString() : null,
          })
          .eq("id", conversationId);

        if (error) {
          // The `enforce_conversation_lock` trigger raises `conversation_locked`
          // when someone else already holds it — surface that distinctly.
          toast.error(
            error.message?.includes("conversation_locked")
              ? t("lockedError")
              : t(errorKey),
          );
          return;
        }
        onChange?.(agentId);
      } catch {
        toast.error(t(errorKey));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, onChange, t],
  );

  const isMine = !!currentUserId && assignedAgentId === currentUserId;
  const canRelease = isMine || canOverrideLock;

  if (!assignedAgentId) {
    return (
      <Banner>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <LockOpen className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground">{t("claim")}</span>
        </div>
        <BannerButton
          onClick={() => setAssignee(currentUserId ?? null, "claimError")}
          busy={busy}
          icon={Lock}
        >
          {t("claim")}
        </BannerButton>
      </Banner>
    );
  }

  return (
    <Banner>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Lock className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        <span className="truncate font-medium text-foreground">
          {isMine ? t("yours") : t("claimedBy", { name: assignedAgentName ?? "—" })}
        </span>
      </div>
      {canRelease && (
        <BannerButton
          onClick={() => setAssignee(null, "releaseError")}
          busy={busy}
          icon={LockOpen}
        >
          {t("release")}
        </BannerButton>
      )}
    </Banner>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs sm:px-4",
      )}
    >
      {children}
    </div>
  );
}

function BannerButton({
  onClick,
  busy,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  busy: boolean;
  icon: typeof Lock;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Icon className="h-3 w-3" />
      )}
      {children}
    </button>
  );
}
