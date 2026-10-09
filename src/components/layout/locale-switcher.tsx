"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Globe, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALES, isLocale, type Locale } from "@/i18n/config";
import { setLocale } from "@/lib/i18n/set-locale";
import { cn } from "@/lib/utils";

/** Native name of each language, shown the same in every locale. */
export const LOCALE_NATIVE_NAME: Record<Locale, string> = {
  es: "Español",
  en: "English",
};

/**
 * Switch the UI language: writes the NEXT_LOCALE cookie through the
 * server action, then refreshes so server components re-render with
 * the new dictionary. Shared by the header/auth switcher and the
 * Settings → Apariencia panel.
 */
export function useLocaleSwitch() {
  const current = useLocale() as Locale;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);

  const switchTo = (next: Locale) => {
    if (next === current) return;
    setPendingLocale(next);
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
      setPendingLocale(null);
    });
  };

  return { locale: current, switchTo, isPending, pendingLocale };
}

/**
 * Compact ES / EN language picker: a globe button with the current
 * code that opens a two-item menu.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("LocaleSwitcher");
  const { locale, switchTo, isPending } = useLocaleSwitch();
  const label = t("change", { name: LOCALE_NATIVE_NAME[locale] });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        disabled={isPending}
        className={cn(
          "flex h-10 items-center gap-1.5 rounded-md px-2 text-xs font-semibold uppercase text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none data-popup-open:bg-muted disabled:opacity-60",
          className,
        )}
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Globe className="h-4 w-4" />
        )}
        <span>{locale}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-auto min-w-40 bg-popover text-popover-foreground ring-border"
      >
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (typeof value === "string" && isLocale(value)) switchTo(value);
          }}
        >
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              <span className="w-6 text-xs font-semibold uppercase text-muted-foreground">
                {l}
              </span>
              {t(l)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
