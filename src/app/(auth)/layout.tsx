import type { Metadata } from "next";
import type { ReactNode } from "react";

import { LocaleSwitcher } from "@/components/layout/locale-switcher";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-40">
        <LocaleSwitcher className="bg-card/80 shadow-sm ring-1 ring-border backdrop-blur" />
      </div>
      {children}
    </>
  );
}
