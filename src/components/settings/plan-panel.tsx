"use client";

import { useLocale, useTranslations } from "next-intl";
import { Loader2, MessageCircle, Sparkles } from "lucide-react";

import { Card } from "@/components/ui/card";
import { SettingsPanelHead } from "@/components/settings/settings-panel-head";
import { SettingsChip, type ChipVariant } from "@/components/settings/settings-chip";
import { UsageBar } from "@/components/plans/usage-bar";
import { MODULE_META } from "@/components/super-admin/modules-panel";
import { useAccountPlan } from "@/hooks/use-account-plan";
import { BUSINESS_TIME_ZONE } from "@/lib/business-timezone";
import { isModuleKey } from "@/lib/modules";
import { PLAN_RESOURCES, type PlanState } from "@/lib/plans/types";

const STATE_VARIANT: Record<PlanState, ChipVariant> = {
  none: "muted",
  trial: "warn",
  active: "ok",
  expiring: "warn",
  past_due: "danger",
  suspended: "danger",
};

/** Configuración → Mi plan: the plan, its state, usage and extras. */
export function PlanPanel() {
  const t = useTranslations("Plan");
  const tSettings = useTranslations("Settings");
  const tSidebar = useTranslations("Sidebar");
  const locale = useLocale();
  const { info, loading } = useAccountPlan();

  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: BUSINESS_TIME_ZONE,
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(iso));
  const money = (price: number, currency: string) => {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(price);
    } catch {
      return `${price} ${currency}`;
    }
  };

  const upgrade = info ? (
    <a
      href={info.upgrade_url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
    >
      <MessageCircle className="size-4" />
      {info.plan ? t("upgrade") : t("getPlan")}
    </a>
  ) : null;

  return (
    <section>
      <SettingsPanelHead
        title={tSettings("sections.plan")}
        description={t("panelDesc")}
        action={upgrade}
      />

      {loading || !info ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t("loading")}
        </div>
      ) : !info.plan ? (
        <Card className="p-5">
          <p className="text-sm text-muted-foreground">{t("noPlan")}</p>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="gap-3 p-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Sparkles className="size-5 text-primary" />
              <h3 className="text-lg font-semibold text-foreground">{info.plan.name}</h3>
              <SettingsChip variant={STATE_VARIANT[info.state]}>
                {t(`states.${info.state}`)}
              </SettingsChip>
            </div>
            {info.plan.description ? (
              <p className="text-sm text-muted-foreground">{info.plan.description}</p>
            ) : null}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-foreground">
                {t("pricePer", {
                  price: money(info.plan.price, info.plan.currency),
                  interval: t(`interval.${info.plan.billing_interval}`),
                })}
              </span>
              {info.expires_at ? (
                <span className="text-muted-foreground">
                  {info.state === "trial"
                    ? t("trialUntil", { date: day(info.expires_at) })
                    : t("paidUntil", { date: day(info.expires_at) })}
                </span>
              ) : null}
            </div>
          </Card>

          {info.usage ? (
            <Card className="gap-4 p-5">
              <h3 className="text-sm font-semibold text-foreground">{t("usageTitle")}</h3>
              {PLAN_RESOURCES.map((r) => (
                <UsageBar
                  key={r}
                  label={t(`resources.${r}`)}
                  used={info.usage![r]}
                  limit={info.limits[r]}
                />
              ))}
              <p className="text-xs text-muted-foreground">{t("usageNote")}</p>
            </Card>
          ) : null}

          {info.extras.length > 0 ? (
            <Card className="gap-3 p-5">
              <h3 className="text-sm font-semibold text-foreground">{t("extrasTitle")}</h3>
              <ul className="space-y-1.5 text-sm">
                {info.extras.map((e) => (
                  <li key={e.id} className="flex flex-wrap justify-between gap-x-3 text-foreground">
                    <span>
                      {e.resource === "module"
                        ? t("extraModule", {
                            name:
                              e.module_key && isModuleKey(e.module_key)
                                ? tSidebar(MODULE_META[e.module_key].labelKey)
                                : (e.module_key ?? ""),
                          })
                        : t("extraResource", {
                            quantity: new Intl.NumberFormat(locale).format(e.quantity),
                            resource: t(`resourceShort.${e.resource}`),
                          })}
                    </span>
                    <span className="text-muted-foreground">
                      {e.expires_at ? t("extraUntil", { date: day(e.expires_at) }) : t("extraPermanent")}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      )}
    </section>
  );
}
