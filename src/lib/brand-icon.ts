import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_BRANDING } from "@/lib/branding";

// Shared by the favicon (`src/app/icon.tsx`), the Apple touch icon and
// the PWA install icons (`src/app/pwa-icon/[size]`), so every icon the
// browser or the home screen shows follows the super admin's uploaded
// favicon (`platform_settings.favicon_url`, migration 062), else the
// branding logo (`logo_url`, migration 040), without a redeploy.
//
// Needs Node's `fs`/`Buffer`: satori can't resolve a bare `/logo.png`
// path with no origin, so logos are inlined as data URIs.

// public/logo.png is a wide icon+wordmark lockup, illegible at icon
// sizes. public/logo-mark.png is the brand mark alone, used as the
// default when nothing was uploaded.
const DEFAULT_MARK_PATH = "/logo-mark.png";

async function readLocalLogo(publicPath: string): Promise<string> {
  const filePath = path.join(process.cwd(), "public", publicPath.replace(/^\//, ""));
  const buffer = await readFile(filePath);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export async function loadBrandIconDataUri(): Promise<string> {
  let logoUrl: string = DEFAULT_BRANDING.logoUrl;
  try {
    const supabase = await createClient();
    const withFavicon = await supabase
      .from("platform_settings")
      .select("logo_url, favicon_url")
      .eq("id", true)
      .maybeSingle();
    let data: { logo_url?: string | null; favicon_url?: string | null } | null = withFavicon.data;
    if (withFavicon.error?.code === "42703") {
      // Migration 062 not applied yet: no favicon column.
      const legacy = await supabase
        .from("platform_settings")
        .select("logo_url")
        .eq("id", true)
        .maybeSingle();
      data = legacy.data;
    }
    if (data?.favicon_url) logoUrl = data.favicon_url;
    else if (data?.logo_url) logoUrl = data.logo_url;
  } catch {
    // Keep the default — this must never block the icon from rendering.
  }

  try {
    if (/^https?:\/\//.test(logoUrl)) {
      const res = await fetch(logoUrl);
      if (!res.ok) throw new Error(`logo fetch failed: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get("content-type") || "image/png";
      return `data:${mime};base64,${buffer.toString("base64")}`;
    }
    return await readLocalLogo(DEFAULT_MARK_PATH);
  } catch {
    return readLocalLogo(DEFAULT_MARK_PATH);
  }
}

/** Reads the branded company name, falling back to `fallback`. */
export async function loadCompanyName(fallback: string): Promise<string> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("platform_settings")
      .select("company_name")
      .eq("id", true)
      .maybeSingle();
    return data?.company_name || fallback;
  } catch {
    return fallback;
  }
}
