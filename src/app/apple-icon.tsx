import { renderPwaIcon } from "@/lib/pwa-icon";

// iOS home-screen icon ("Añadir a pantalla de inicio"). iOS ignores the
// web manifest's icons and rounds the corners itself.
export const runtime = "nodejs";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return renderPwaIcon(180, 0.1);
}
