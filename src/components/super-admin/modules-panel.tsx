"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Bell,
  Bot,
  Calendar,
  GitBranch,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  PlugZap,
  Radio,
  Users,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsPanelHead } from "@/components/settings/settings-panel-head";
import {
  MODULE_KEYS,
  isModuleEnabled,
  type EnabledModules,
  type ModuleKey,
} from "@/lib/modules";

// Icon + Sidebar-namespace label for each togglable module, so this
// panel reads the same names the client actually sees in their menu.
const MODULE_META: Record<ModuleKey, { icon: LucideIcon; labelKey: string }> = {
  inbox: { icon: MessageSquare, labelKey: "inbox" },
  agenda: { icon: Calendar, labelKey: "agenda" },
  notifications: { icon: Bell, labelKey: "notifications" },
  contacts: { icon: Users, labelKey: "contacts" },
  pipelines: { icon: GitBranch, labelKey: "pipelines" },
  broadcasts: { icon: Radio, labelKey: "broadcasts" },
  automations: { icon: Zap, labelKey: "automations" },
  flows: { icon: Workflow, labelKey: "flows" },
  agents: { icon: Bot, labelKey: "aiAgents" },
  catalog: { icon: ImageIcon, labelKey: "catalog" },
  channels: { icon: PlugZap, labelKey: "channels" },
};

interface AccountOption {
  id: string;
  name: string;
  enabled_modules: EnabledModules;
}

export function ModulesPanel() {
  const t = useTranslations("SuperAdmin.modules");
  const tSidebar = useTranslations("Sidebar");

  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Record<ModuleKey, boolean>>(
    {} as Record<ModuleKey, boolean>,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/super-admin/accounts");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { accounts: AccountOption[] };
        setAccounts(data.accounts ?? []);
        if (data.accounts?.[0]) setSelectedId(data.accounts[0].id);
      } catch {
        toast.error(t("loadFailed"));
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    const next = {} as Record<ModuleKey, boolean>;
    for (const key of MODULE_KEYS) {
      next[key] = isModuleEnabled(selected.enabled_modules, key);
    }
    setDraft(next);
    // Only re-derive when the selected account itself changes — not on
    // every keystroke-level re-render of `accounts`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const dirty =
    !!selected &&
    MODULE_KEYS.some(
      (key) => draft[key] !== isModuleEnabled(selected.enabled_modules, key),
    );

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/super-admin/accounts/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled_modules: draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t("saveFailed"));
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === selected.id ? { ...a, enabled_modules: { ...draft } } : a,
        ),
      );
      toast.success(t("saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t("loading")}
        </div>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noAccounts")}</p>
      ) : (
        <div className="space-y-4">
          <div className="max-w-sm">
            <Select
              value={selectedId}
              onValueChange={(v) => v && setSelectedId(v)}
            >
              <SelectTrigger className="w-full border-border bg-muted text-foreground">
                <SelectValue placeholder={t("accountPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selected && (
            <Card>
              <CardContent className="divide-y divide-border p-0">
                {MODULE_KEYS.map((key) => {
                  const meta = MODULE_META[key];
                  const Icon = meta.icon;
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <Icon className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium text-foreground">
                          {tSidebar(meta.labelKey)}
                        </span>
                      </div>
                      <Switch
                        checked={draft[key] ?? true}
                        onCheckedChange={(v) =>
                          setDraft((prev) => ({ ...prev, [key]: !!v }))
                        }
                        aria-label={tSidebar(meta.labelKey)}
                        disabled={saving}
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving || !dirty}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("saveChanges")
              )}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
