import { renderPwaIcon } from "@/lib/pwa-icon";

// PWA install icons referenced by `src/app/manifest.ts`:
// /pwa-icon/192, /pwa-icon/512 and their maskable variants.
export const runtime = "nodejs";

const SIZES: Record<string, { size: number; padding: number }> = {
  "192": { size: 192, padding: 0.08 },
  "512": { size: 512, padding: 0.08 },
  "maskable-192": { size: 192, padding: 0.2 },
  "maskable-512": { size: 512, padding: 0.2 },
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> },
) {
  const { size } = await params;
  const spec = SIZES[size];
  if (!spec) return new Response("Not found", { status: 404 });
  const image = await renderPwaIcon(spec.size, spec.padding);
  image.headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  return image;
}
