'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import {
  OPENAI_CHAT_MODELS,
  OPENAI_EMBEDDING_MODELS,
  DEFAULT_EMBEDDINGS_MODEL,
} from '@/lib/ai/models';
import type { AiProvider } from '@/lib/ai/types';

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

/** Provider + model picker shared by the platform panel and own keys. */
export function ProviderModelFields({
  provider,
  model,
  onProvider,
  onModel,
  disabled,
  idPrefix,
}: {
  provider: AiProvider;
  model: string;
  onProvider: (p: AiProvider) => void;
  onModel: (m: string) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const t = useTranslations('Settings.aiConfig');
  const changeProvider = (next: AiProvider) => {
    onProvider(next);
    const isDefault =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model.trim() === '';
    if (isDefault) onModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label>{t('provider')}</Label>
        <Select
          value={provider}
          onValueChange={(v) => changeProvider(v as AiProvider)}
          disabled={disabled}
        >
          <SelectTrigger className="w-full">
            <SelectValue>{(v: AiProvider) => PROVIDER_LABEL[v] ?? v}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
            <SelectItem value="anthropic">{PROVIDER_LABEL.anthropic}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-model`}>{t('model')}</Label>
        {provider === 'openai' ? (
          <Select value={model} onValueChange={(v) => onModel(v ?? '')} disabled={disabled}>
            <SelectTrigger id={`${idPrefix}-model`} className="w-full">
              <SelectValue>
                {(v: string) => OPENAI_CHAT_MODELS.find((m) => m.id === v)?.label ?? v}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {OPENAI_CHAT_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={`${idPrefix}-model`}
            value={model}
            onChange={(e) => onModel(e.target.value)}
            placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}

export function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled: boolean;
}) {
  const t = useTranslations('Settings.aiConfig');
  const [show, setShow] = useState(false);
  return (
    <div className="relative flex-1">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? t('hideKey') : t('showKey')}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

interface PlatformStatus {
  configured: boolean;
  migration_pending: boolean;
  provider?: AiProvider;
  model?: string;
  key_hint?: string | null;
  has_embeddings_key?: boolean;
  embeddings_key_hint?: string | null;
  embeddings_model?: string;
}

/**
 * Super admin → IA de la plataforma. The one provider key every account
 * runs on unless the super admin gives it its own (migration 072). The
 * platform pays for it and bills it inside the plan.
 */
export function PlatformAiPanel() {
  const t = useTranslations('SuperAdmin.platformAi');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsModel, setEmbeddingsModel] = useState(DEFAULT_EMBEDDINGS_MODEL);
  const [clearEmbeddings, setClearEmbeddings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/super-admin/ai-platform', { cache: 'no-store' });
      const data = (await res.json()) as PlatformStatus & { error?: string };
      if (!res.ok) throw new Error(data.error);
      setStatus(data);
      if (data.configured) {
        setProvider(data.provider ?? 'openai');
        setModel(data.model ?? AI_PROVIDER_DEFAULT_MODEL.openai);
        setEmbeddingsModel(data.embeddings_model || DEFAULT_EMBEDDINGS_MODEL);
      }
      setApiKey('');
      setEmbeddingsKey('');
      setClearEmbeddings(false);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: model.trim(), api_key: apiKey.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess'));
      else toast.error(data.error ?? t('testFailed'));
    } catch {
      toast.error(t('testFailed'));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (!status?.configured && !apiKey.trim()) {
      toast.error(t('missingKey'));
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        provider,
        model: model.trim(),
        embeddings_model: embeddingsModel,
      };
      if (apiKey.trim()) body.api_key = apiKey.trim();
      if (embeddingsKey.trim()) body.embeddings_api_key = embeddingsKey.trim();
      else if (clearEmbeddings) body.embeddings_api_key = null;
      const res = await fetch('/api/super-admin/ai-platform', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saved'));
        await load();
      } else if (data.code === 'migration_pending') {
        toast.error(t('migrationPending'));
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  if (status?.migration_pending) {
    return (
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('migrationPending')}
        </p>
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-primary" /> {t('keyTitle')}
            </CardTitle>
            <CardDescription>
              {status?.configured
                ? t('keySaved', { hint: status.key_hint ?? '••••' })
                : t('keyMissing')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ProviderModelFields
              provider={provider}
              model={model}
              onProvider={setProvider}
              onModel={setModel}
              disabled={saving}
              idPrefix="platform-ai"
            />
            <div className="space-y-2">
              <Label htmlFor="platform-ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <SecretInput
                  id="platform-ai-key"
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={
                    status?.configured ? t('keepKeyPlaceholder') : KEY_PLACEHOLDER[provider]
                  }
                  disabled={saving}
                />
                <Button variant="outline" onClick={test} disabled={saving || testing}>
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('test')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('encryptionNotice')}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('embeddingsTitle')}</CardTitle>
            <CardDescription>
              {status?.has_embeddings_key && !clearEmbeddings
                ? t('embeddingsSaved', { hint: status.embeddings_key_hint ?? '••••' })
                : t('embeddingsMissing')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="platform-ai-emb-key">{t('embeddingsKey')}</Label>
              <div className="flex gap-2">
                <SecretInput
                  id="platform-ai-emb-key"
                  value={embeddingsKey}
                  onChange={(v) => {
                    setEmbeddingsKey(v);
                    if (v) setClearEmbeddings(false);
                  }}
                  placeholder={
                    status?.has_embeddings_key ? t('keepKeyPlaceholder') : 'sk-... (OpenAI)'
                  }
                  disabled={saving}
                />
                {status?.has_embeddings_key && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setClearEmbeddings((c) => !c);
                      setEmbeddingsKey('');
                    }}
                    disabled={saving}
                    className={clearEmbeddings ? 'text-destructive' : undefined}
                  >
                    {clearEmbeddings ? t('undoClear') : t('clearKey')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('embeddingsHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="platform-ai-emb-model">{t('embeddingsModel')}</Label>
              <Select
                value={embeddingsModel}
                onValueChange={(v) => setEmbeddingsModel(v ?? DEFAULT_EMBEDDINGS_MODEL)}
                disabled={saving}
              >
                <SelectTrigger id="platform-ai-emb-model" className="w-full">
                  <SelectValue>
                    {(v: string) => OPENAI_EMBEDDING_MODELS.find((m) => m.id === v)?.label ?? v}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {OPENAI_EMBEDDING_MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
