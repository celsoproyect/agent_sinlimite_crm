import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_BRANDING } from "@/lib/branding";

// Renders the browser-tab favicon from this deployment's branding logo
// (`platform_settings.logo_url`, migration 040) instead of a fixed
// brand mark, so a super admin's uploaded logo shows up in the tab
// without a redeploy — mirrors the title logic in `src/app/layout.tsx`.
//
// Needs Node's `fs`/`Buffer` to read the local default logo and to
// inline a fetched remote logo as a data URI (satori can't resolve a
// bare `/logo.png` path with no origin), so this can't run on edge.
export const runtime = "nodejs";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

async function readLocalLogo(publicPath: string): Promise<string> {
  const filePath = path.join(process.cwd(), "public", publicPath.replace(/^\//, ""));
  const buffer = await readFile(filePath);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function loadLogoDataUri(): Promise<string> {
  let logoUrl: string = DEFAULT_BRANDING.logoUrl;
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("platform_settings")
      .select("logo_url")
      .eq("id", true)
      .maybeSingle();
    if (data?.logo_url) logoUrl = data.logo_url;
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
    return await readLocalLogo(logoUrl);
  } catch {
    return readLocalLogo(DEFAULT_BRANDING.logoUrl);
  }
}

export default async function Icon() {
  const logo = await loadLogoDataUri();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt=""
          width={32}
          height={32}
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    { ...size },
  );
}
