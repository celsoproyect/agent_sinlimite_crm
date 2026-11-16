"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import QRCode from "qrcode";
import { Copy, Download, ExternalLink, Loader2, Pencil, Plus, QrCode, Trash2 } from "lucide-react";
import type { InstagramLink, LinkAction, LinkStats } from "@/lib/instagram/links";
import { REPORT_PRESETS, presetRange, type ReportPreset } from "@/lib/reports/range";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SampleDataBar } from "@/components/samples/sample-data-bar";
import { SELECT_CLASS } from "./instagram-utils";

// Kept here: lib/instagram/links.ts is server code (type imports only).
const LINK_ACTIONS: LinkAction[] = ["message", "ai", "rule", "automation"];

type LinkRow = InstagramLink & { short_url: string | null; ig_url: string | null; stats: LinkStats };
type Option = { id: string; name: string };
type LinksData =
  | { migrated: false }
  | {
      migrated: true;
      connected: boolean;
      username: string | null;
      links: LinkRow[];
      rules: Option[];
      automations: Option[];
      tags: Option[];
    };

const KNOWN_ERRORS = new Set([
  "name_required",
  "invalid_code",
  "invalid_action",
  "invalid_reference",
  "welcome_required",
  "rule_required",
  "automation_required",
  "code_taken",
  "module_disabled",
  "not_found",
]);

async function errorText(res: Response | null, t: ReturnType<typeof useTranslations>): Promise<string> {
  if (!res) return t("errors.generic");
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  const code = json?.error ?? "";
  if (KNOWN_ERRORS.has(code)) return t(`errors.${code}`);
  if (res.status === 403) return t("errors.forbidden");
  return t("errors.generic");
}

async function copy(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error(text);
  }
}

// Enlaces y QR (module instagram_links, migration 083): each link opens the
// business's Instagram chat with a code, runs its action and counts
// clicks, chats, new contacts and the sales that followed.
export function LinksPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations("InstagramLinks");
  const tr = useTranslations("Reports");
  const [preset, setPreset] = useState<ReportPreset>("last30");
  const [data, setData] = useState<LinksData | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<LinkRow | "new" | null>(null);
  const [qrFor, setQrFor] = useState<LinkRow | null>(null);

  const load = useCallback(async () => {
    const range = presetRange(preset);
    const res = await fetch(`/api/instagram/links?from=${range.from}&to=${range.to}`).catch(() => null);
    if (!res?.ok) {
      setFailed(true);
      if (res) toast.error(await errorText(res, t));
      return;
    }
    setFailed(false);
    setData((await res.json()) as LinksData);
  }, [preset, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reloads when the range changes
    void load();
  }, [load]);

  async function remove(link: LinkRow) {
    if (!confirm(t("confirmDelete", { name: link.name }))) return;
    const res = await fetch(`/api/instagram/links/${link.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      toast.error(await errorText(res, t));
      return;
    }
    void load();
  }

  async function toggle(link: LinkRow, active: boolean) {
    const res = await fetch(`/api/instagram/links/${link.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    }).catch(() => null);
    if (!res?.ok) toast.error(await errorText(res, t));
    void load();
  }

  if (!data) {
    return failed ? (
      <p className="text-sm text-muted-foreground">{t("errors.generic")}</p>
    ) : (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (!data.migrated) {
    return <p className="rounded-xl border border-border bg-card p-4 text-sm text-foreground shadow-sm">{t("needsMigration")}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground shadow-sm">
        <p className="font-medium text-foreground">{t("howTitle")}</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
          <li>{t("how1")}</li>
          <li>{t("how2")}</li>
          <li>{t("how3")}</li>
        </ol>
      </div>

      {!data.connected && <p className="text-sm text-destructive">{t("notConnected")}</p>}
      {canManage && (
        <SampleDataBar module="instagram_links" hasSamples={data.links.some((l) => l.is_sample)} onChanged={load} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
          {REPORT_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPreset(p)}
              className={
                preset === p
                  ? "min-h-9 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground sm:min-h-0"
                  : "min-h-9 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-0"
              }
            >
              {tr(`presets.${p}`)}
            </button>
          ))}
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-4 w-4" />
            {t("newLink")}
          </Button>
        )}
      </div>

      {data.links.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.links.map((link) => (
            <LinkCard
              key={link.id}
              link={link}
              canManage={canManage}
              onEdit={() => setEditing(link)}
              onDelete={() => void remove(link)}
              onToggle={(active) => void toggle(link, active)}
              onQr={() => setQrFor(link)}
            />
          ))}
        </div>
      )}

      <LinkFormDialog
        open={!!editing}
        link={editing === "new" ? null : editing}
        data={data}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
      <QrDialog link={qrFor} onOpenChange={(o) => !o && setQrFor(null)} />
    </div>
  );
}

function LinkCard({
  link,
  canManage,
  onEdit,
  onDelete,
  onToggle,
  onQr,
}: {
  link: LinkRow;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (active: boolean) => void;
  onQr: () => void;
}) {
  const t = useTranslations("InstagramLinks");
  const url = link.short_url ?? link.ig_url;
  const s = link.stats;
  const stats: [string, string][] = [
    [t("stats.clicks"), String(s.clicks)],
    [t("stats.chats"), String(s.chats)],
    [t("stats.newContacts"), String(s.newContacts)],
    [t("stats.deals"), String(s.deals)],
    [t("stats.won"), String(s.won)],
    [t("stats.revenue"), s.revenue > 0 ? Math.round(s.revenue).toLocaleString("es-DO") : "—"],
  ];
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-foreground">{link.name}</p>
          <p className="text-xs text-muted-foreground">
            {t("code")}: <span className="font-mono">{link.code}</span> · {t(`actions.${link.action}`)}
            {link.is_sample && <span className="ml-1 rounded bg-muted px-1">{t("sample")}</span>}
          </p>
        </div>
        {canManage && <Switch checked={link.active} onCheckedChange={onToggle} aria-label={t("active")} />}
      </div>

      {url ? (
        <div className="flex items-center gap-1 rounded-md bg-muted px-2 py-1">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{url}</span>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => void copy(url, t("copied"))} aria-label={t("copy")}>
            <Copy className="h-4 w-4" />
          </Button>
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground" aria-label={t("open")}>
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      ) : (
        <p className="text-xs text-destructive">{t("noUrl")}</p>
      )}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-md border border-border px-2 py-1">
            <p className="text-sm font-semibold text-foreground">{value}</p>
            <p className="text-[0.7rem] leading-tight text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onQr} disabled={!url}>
          <QrCode className="mr-1 h-4 w-4" />
          {t("qr")}
        </Button>
        {link.ig_url && link.short_url && (
          <Button size="sm" variant="ghost" onClick={() => void copy(link.ig_url!, t("copied"))}>
            <Copy className="mr-1 h-4 w-4" />
            {t("copyDirect")}
          </Button>
        )}
        {canManage && (
          <>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <Pencil className="mr-1 h-4 w-4" />
              {t("edit")}
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
              <Trash2 className="mr-1 h-4 w-4" />
              {t("delete")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function QrDialog({ link, onOpenChange }: { link: LinkRow | null; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("InstagramLinks");
  const [image, setImage] = useState<string | null>(null);
  const url = link ? (link.short_url ?? link.ig_url) : null;

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    QRCode.toDataURL(url, { width: 1024, margin: 2, errorCorrectionLevel: "M" })
      .then((src) => !cancelled && setImage(src))
      .catch(() => !cancelled && setImage(null));
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <Dialog open={!!link} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{link?.name}</DialogTitle>
        </DialogHeader>
        {image && url ? (
          <div className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
            <img src={image} alt={t("qr")} className="mx-auto w-full max-w-64 rounded-md bg-white" />
            <p className="break-all text-center font-mono text-xs text-muted-foreground">{url}</p>
            <p className="text-xs text-muted-foreground">{t("qrHint")}</p>
            <DialogFooter>
              <a href={image} download={`qr-${link?.code.toLowerCase()}.png`}>
                <Button size="sm">
                  <Download className="mr-1 h-4 w-4" />
                  {t("download")}
                </Button>
              </a>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LinkFormDialog({
  open,
  link,
  data,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  link: LinkRow | null;
  data: Extract<LinksData, { migrated: true }>;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const t = useTranslations("InstagramLinks");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{link ? t("editLink") : t("newLink")}</DialogTitle>
        </DialogHeader>
        {open && <LinkForm key={link?.id ?? "new"} link={link} data={data} onCancel={() => onOpenChange(false)} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function LinkForm({
  link,
  data,
  onCancel,
  onSaved,
}: {
  link: LinkRow | null;
  data: Extract<LinksData, { migrated: true }>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("InstagramLinks");
  const [name, setName] = useState(link?.name ?? "");
  const [code, setCode] = useState(link?.code ?? "");
  const [action, setAction] = useState<LinkAction>(link?.action ?? "message");
  const [welcome, setWelcome] = useState(link?.welcome_text ?? "");
  const [context, setContext] = useState(link?.ai_context ?? "");
  const [ruleId, setRuleId] = useState(link?.rule_id ?? "");
  const [automationId, setAutomationId] = useState(link?.automation_id ?? "");
  const [tagId, setTagId] = useState(link?.tag_id ?? "");
  const [active, setActive] = useState(link?.active ?? true);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const body = {
      name,
      code,
      action,
      welcome_text: welcome,
      ai_context: context,
      rule_id: action === "rule" ? ruleId || null : null,
      automation_id: action === "automation" ? automationId || null : null,
      tag_id: tagId || null,
      active,
    };
    const res = await fetch(link ? `/api/instagram/links/${link.id}` : "/api/instagram/links", {
      method: link ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      toast.error(await errorText(res, t));
      return;
    }
    toast.success(t("saved"));
    onSaved();
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>{t("name")}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} maxLength={120} />
      </div>
      <div className="space-y-1">
        <Label>{t("code")}</Label>
        <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="QR_LOCAL" maxLength={40} className="font-mono" />
        <p className="text-xs text-muted-foreground">{t("codeHint")}</p>
      </div>
      <div className="space-y-1">
        <Label>{t("action")}</Label>
        <select className={SELECT_CLASS} value={action} onChange={(e) => setAction(e.target.value as LinkAction)}>
          {LINK_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {t(`actions.${a}`)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t(`actionHints.${action}`)}</p>
      </div>
      {action === "rule" && (
        <div className="space-y-1">
          <Label>{t("rule")}</Label>
          <select className={SELECT_CLASS} value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
            <option value="">{t("choose")}</option>
            {data.rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {action === "automation" && (
        <div className="space-y-1">
          <Label>{t("automation")}</Label>
          <select className={SELECT_CLASS} value={automationId} onChange={(e) => setAutomationId(e.target.value)}>
            <option value="">{t("choose")}</option>
            {data.automations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1">
        <Label>{action === "message" ? t("welcome") : t("welcomeOptional")}</Label>
        <Textarea value={welcome} onChange={(e) => setWelcome(e.target.value)} rows={4} maxLength={1000} placeholder={t("welcomePlaceholder")} />
      </div>
      <div className="space-y-1">
        <Label>{t("aiContext")}</Label>
        <Textarea value={context} onChange={(e) => setContext(e.target.value)} rows={3} maxLength={2000} placeholder={t("aiContextPlaceholder")} />
        <p className="text-xs text-muted-foreground">{t("aiContextHint")}</p>
      </div>
      <div className="space-y-1">
        <Label>{t("tag")}</Label>
        <select className={SELECT_CLASS} value={tagId} onChange={(e) => setTagId(e.target.value)}>
          <option value="">{t("noTag")}</option>
          {data.tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label>{t("active")}</Label>
        <Switch checked={active} onCheckedChange={setActive} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          {t("save")}
        </Button>
      </DialogFooter>
    </div>
  );
}
