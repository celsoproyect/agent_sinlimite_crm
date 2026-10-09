import { ImageResponse } from "next/og";
import { loadBrandIconDataUri } from "@/lib/brand-icon";

/**
 * Renders the brand mark centred on a white square, the shape home
 * screens and app launchers expect. `padding` is the share of each side
 * left blank: maskable icons keep their mark inside the central 80%
 * "safe zone" because Android crops them to a circle or squircle.
 */
export async function renderPwaIcon(size: number, padding: number) {
  const logo = await loadBrandIconDataUri();
  const inner = Math.round(size * (1 - padding * 2));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logo}
          alt=""
          width={inner}
          height={inner}
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    { width: size, height: size },
  );
}
