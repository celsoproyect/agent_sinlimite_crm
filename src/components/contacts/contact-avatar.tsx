"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

// Background/foreground pairs for the initials avatar. Each contact gets
// the same one every time (hashed from its id), so a conversation is
// recognisable at a glance even without a photo. The pairs read on both
// the light and dark surfaces.
const PALETTE = [
  "bg-rose-500/15 text-rose-600",
  "bg-orange-500/15 text-orange-600",
  "bg-amber-500/15 text-amber-700",
  "bg-lime-500/15 text-lime-700",
  "bg-emerald-500/15 text-emerald-600",
  "bg-teal-500/15 text-teal-600",
  "bg-cyan-500/15 text-cyan-600",
  "bg-sky-500/15 text-sky-600",
  "bg-indigo-500/15 text-indigo-500",
  "bg-violet-500/15 text-violet-500",
  "bg-fuchsia-500/15 text-fuchsia-600",
  "bg-pink-500/15 text-pink-600",
];

const SIZES = {
  sm: "size-9 text-sm",
  md: "size-10 text-sm",
  lg: "size-16 text-lg",
} as const;

export function avatarTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Up to two initials from the name ("Ana Pérez" → "AP"), else the first
 *  character of whatever identifies the contact. */
export function contactInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return (words[0]?.[0] ?? name.trim()[0] ?? "?").toUpperCase();
}

interface ContactAvatarProps {
  name: string;
  avatarUrl?: string | null;
  /** Stable key for the color (the contact id); falls back to the name. */
  seed?: string;
  size?: keyof typeof SIZES;
  className?: string;
}

/**
 * A contact's photo when one was uploaded (WhatsApp's Cloud API never
 * sends profile pictures), else colored initials. A photo URL that fails
 * to load also falls back to the initials.
 */
export function ContactAvatar({ name, avatarUrl, seed, size = "md", className }: ContactAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showPhoto = !!avatarUrl && failedUrl !== avatarUrl;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        SIZES[size],
        !showPhoto && avatarTone(seed || name),
        className,
      )}
    >
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element -- Supabase Storage URL
        <img
          src={avatarUrl}
          alt={name}
          className="size-full object-cover"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        contactInitials(name)
      )}
    </div>
  );
}
