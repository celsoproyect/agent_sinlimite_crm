import { ImageResponse } from "next/og";
import { loadBrandIconDataUri } from "@/lib/brand-icon";

// Renders the browser-tab favicon from this deployment's uploaded
// favicon, else its branding logo (see `src/lib/brand-icon.ts`), so a
// super admin's uploaded logo shows up in the tab without a redeploy.
// Node runtime: the logo loader reads files and builds data URIs.
export const runtime = "nodejs";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  const logo = await loadBrandIconDataUri();
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
