"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LOST_REASONS, type LostReason } from "@/lib/deals/reasons";
import { cn } from "@/lib/utils";

interface LostReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealTitle?: string;
  /** Resolves once the deal is closed; the dialog stays open on throw. */
  onConfirm: (reason: LostReason, note: string) => Promise<void>;
}

/** Asks why a deal was lost before closing it. A reason is required. */
export function LostReasonDialog({ open, onOpenChange, dealTitle, onConfirm }: LostReasonDialogProps) {
  const t = useTranslations("Pipelines.closed");
  const [reason, setReason] = useState<LostReason | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  function handleOpenChange(next: boolean) {
    if (saving) return;
    if (!next) {
      setReason(null);
      setNote("");
    }
    onOpenChange(next);
  }

  async function confirm() {
    if (!reason) return;
    setSaving(true);
    try {
      await onConfirm(reason, note.trim());
      setReason(null);
      setNote("");
    } catch {
      // The caller already reported the failure; keep the dialog open.
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("lostDialogTitle")}</DialogTitle>
          {dealTitle && <p className="text-sm text-muted-foreground">{dealTitle}</p>}
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("reason")}</Label>
            <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
              {LOST_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    reason === r
                      ? "border-primary bg-primary/10 font-medium text-foreground"
                      : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`reasons.${r}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("note")}</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("notePlaceholder")}
              maxLength={1000}
              className="min-h-[80px] border-border bg-muted text-foreground"
            />
          </div>
        </div>

        <DialogFooter className="border-border bg-popover/50">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={saving}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={confirm}
            disabled={!reason || saving}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            {t("markLost")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
