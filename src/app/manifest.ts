import type { MetadataRoute } from "next";
import { DEFAULT_COMPANY_NAME } from "@/lib/branding";
import { loadCompanyName } from "@/lib/brand-icon";

// Web app manifest: makes the CRM installable (Chrome/Edge "Instalar",
// Android "Añadir a pantalla de inicio") and opens it full-screen like
// a native app. The name follows the super admin's branding.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const name = await loadCompanyName(DEFAULT_COMPANY_NAME);
  return {
    id: "/",
    name,
    short_name: name.length > 12 ? name.split(/\s+/)[0] : name,
    description: "CRM con agentes de IA para WhatsApp",
    lang: "es",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#F5F7FB",
    theme_color: "#2563EB",
    categories: ["business", "productivity"],
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/maskable-192", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/pwa-icon/maskable-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Bandeja", url: "/inbox" },
      { name: "Agenda", url: "/agenda" },
      { name: "Contactos", url: "/contacts" },
    ],
  };
}
