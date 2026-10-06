"use client";

import { useRef, useState } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import type { Contact } from "@/types";
import { ContactAvatar } from "./contact-avatar";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
// The `chat-media` bucket (migration 023) only accepts these image types.
const PHOTO_MIME = ["image/png", "image/jpeg", "image/webp"];

interface ContactPhotoEditorProps {
  contact: Pick<Contact, "id" | "name" | "phone" | "avatar_url">;
  /** Called with the saved URL (null when removed). */
  onChange: (avatarUrl: string | null) => void;
}

/**
 * Large contact avatar with buttons to upload or remove a photo. WhatsApp
 * never sends profile pictures, so this is the only way one gets set.
 */
export function ContactPhotoEditor({ contact, onChange }: ContactPhotoEditorProps) {
  const t = useTranslations("Contacts.photo");
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const name = contact.name || contact.phone || "?";

  async function save(avatarUrl: string | null) {
    const { data, error } = await createClient()
      .from("contacts")
      .update({ avatar_url: avatarUrl })
      .eq("id", contact.id)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error(t("saveFailed"));
    onChange(avatarUrl);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!PHOTO_MIME.includes(file.type)) {
      toast.error(t("unsupported"));
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      toast.error(t("tooLarge"));
      return;
    }
    setBusy(true);
    try {
      const { publicUrl } = await uploadAccountMedia("chat-media", file);
      await save(publicUrl);
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    setBusy(true);
    try {
      await save(null);
      toast.success(t("removed"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="group relative">
        <ContactAvatar name={name} avatarUrl={contact.avatar_url} seed={contact.id} size="lg" />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          title={contact.avatar_url ? t("change") : t("upload")}
          aria-label={contact.avatar_url ? t("change") : t("upload")}
          className="absolute -right-1 -bottom-1 flex size-7 items-center justify-center rounded-full border-2 border-card bg-primary text-primary-foreground shadow transition-transform hover:scale-105 disabled:opacity-70"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
        </button>
      </div>
      {contact.avatar_url && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-destructive disabled:opacity-60"
        >
          <Trash2 className="size-3" />
          {t("remove")}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={PHOTO_MIME.join(",")}
        className="hidden"
        onChange={onFile}
      />
    </div>
  );
}
