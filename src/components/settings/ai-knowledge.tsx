'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  RefreshCw,
  BookOpen,
  Upload,
  FileText,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useTranslations } from 'next-intl';

interface KbSummary {
  id: string;
  name: string;
  description: string;
  updated_at: string;
}

interface DocSummary {
  id: string;
  title: string;
  updated_at: string;
  metadata?: { source?: string; file_name?: string } | null;
}

const UPLOAD_ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md';
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

/** Editor target: 'new' when creating, a doc id when editing, null when closed. */
type EditTarget = 'new' | string | null;
/** Same shape for the knowledge-base collection editor. */
type KbEditTarget = 'new' | string | null;

export function AiKnowledgeCard({
  accountId,
  canEdit,
  hasEmbeddingsKey,
}: {
  accountId: string | null;
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const t = useTranslations('Settings.aiKnowledge');
  const [kbs, setKbs] = useState<KbSummary[]>([]);
  const [loadingKbs, setLoadingKbs] = useState(true);
  const [selectedKb, setSelectedKb] = useState<KbSummary | null>(null);
  const [kbEditing, setKbEditing] = useState<KbEditTarget>(null);
  const [kbName, setKbName] = useState('');
  const [kbDescription, setKbDescription] = useState('');
  const [kbSaving, setKbSaving] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchKbs = useCallback(async () => {
    setLoadingKbs(true);
    try {
      const res = await fetch('/api/ai/knowledge-bases');
      const data = await res.json();
      if (res.ok) setKbs(data.knowledgeBases ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoadingKbs(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchKbs();
  }, [accountId, fetchKbs]);

  const openNewKb = () => {
    setKbEditing('new');
    setKbName('');
    setKbDescription('');
  };

  const openEditKb = (kb: KbSummary) => {
    setKbEditing(kb.id);
    setKbName(kb.name);
    setKbDescription(kb.description);
  };

  const cancelEditKb = () => {
    setKbEditing(null);
    setKbName('');
    setKbDescription('');
  };

  const saveKb = async () => {
    if (!kbName.trim() || !kbDescription.trim()) {
      toast.error(t('kbNameDescriptionRequired'));
      return;
    }
    setKbSaving(true);
    try {
      const isNew = kbEditing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/knowledge-bases' : `/api/ai/knowledge-bases/${kbEditing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: kbName.trim(),
            description: kbDescription.trim(),
          }),
        },
      );
      const data = await res.json();
      if (res.ok) {
        toast.success(isNew ? t('kbSaveSuccessNew') : t('kbSaveSuccessUpdate'));
        cancelEditKb();
        await fetchKbs();
        if (!isNew && data.knowledgeBase && selectedKb?.id === kbEditing) {
          setSelectedKb(data.knowledgeBase);
        }
      } else {
        toast.error(data.error ?? t('kbSaveFailed'));
      }
    } catch {
      toast.error(t('kbSaveFailed'));
    } finally {
      setKbSaving(false);
    }
  };

  const removeKb = async (kb: KbSummary) => {
    if (!window.confirm(t('kbDeleteConfirm', { name: kb.name }))) return;
    try {
      const res = await fetch(`/api/ai/knowledge-bases/${kb.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(t('kbRemoveSuccess'));
        setKbs((list) => list.filter((x) => x.id !== kb.id));
        if (selectedKb?.id === kb.id) setSelectedKb(null);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('kbRemoveFailed'));
      }
    } catch {
      toast.error(t('kbRemoveFailed'));
    }
  };

  if (selectedKb) {
    return (
      <KnowledgeBaseDetail
        kb={selectedKb}
        canEdit={canEdit}
        hasEmbeddingsKey={hasEmbeddingsKey}
        onBack={() => setSelectedKb(null)}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>
          {t('description', {
            searchType: hasEmbeddingsKey ? t('semanticSearchOn') : t('keywordSearchOn'),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadingKbs ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {kbs.length === 0 && kbEditing === null && (
              <p className="text-sm text-muted-foreground">{t('noKbs')}</p>
            )}

            {kbs.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {kbs.map((kb) => (
                  <li
                    key={kb.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-accent/50"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedKb(kb)}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                    >
                      <span className="truncate text-sm font-medium text-foreground">
                        {kb.name}
                      </span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {kb.description}
                      </span>
                    </button>
                    {canEdit && (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => openEditKb(kb)}
                          title={t('editKb')}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void removeKb(kb)}
                          title={t('deleteKb')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {kbEditing !== null ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="kb-name">{t('kbNameLabel')}</Label>
                  <Input
                    id="kb-name"
                    value={kbName}
                    onChange={(e) => setKbName(e.target.value)}
                    placeholder={t('kbNamePlaceholder')}
                    disabled={kbSaving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kb-description">{t('kbDescriptionLabel')}</Label>
                  <Textarea
                    id="kb-description"
                    value={kbDescription}
                    onChange={(e) => setKbDescription(e.target.value)}
                    placeholder={t('kbDescriptionPlaceholder')}
                    rows={3}
                    disabled={kbSaving}
                  />
                  <p className="text-xs text-muted-foreground">{t('kbDescriptionHint')}</p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEditKb} disabled={kbSaving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={saveKb} disabled={kbSaving}>
                    {kbSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('saveKb')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <Button variant="outline" size="sm" onClick={openNewKb}>
                  <Plus className="mr-2 h-4 w-4" /> {t('newKb')}
                </Button>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function KnowledgeBaseDetail({
  kb,
  canEdit,
  hasEmbeddingsKey,
  onBack,
}: {
  kb: KbSummary;
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
  onBack: () => void;
}) {
  const t = useTranslations('Settings.aiKnowledge');
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/ai/knowledge?knowledge_base_id=${encodeURIComponent(kb.id)}`,
      );
      const data = await res.json();
      if (res.ok) setDocs(data.documents ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [kb.id, t]);

  useEffect(() => {
    void fetchDocs();
  }, [fetchDocs]);

  const openNew = () => {
    setEditing('new');
    setTitle('');
    setContent('');
  };

  const openEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('openFailed'));
        return;
      }
      setEditing(id);
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
    } catch {
      toast.error(t('openFailed'));
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setTitle('');
    setContent('');
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error(t('titleContentRequired'));
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/knowledge' : `/api/ai/knowledge/${editing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title.trim(),
            content: content.trim(),
            ...(isNew ? { knowledge_base_id: kb.id } : {}),
          }),
        },
      );
      const data = await res.json();
      if (res.ok) {
        // A 200 with `warning` means saved but indexing degraded.
        if (data.warning) toast.warning(data.warning);
        else toast.success(isNew ? t('saveSuccessNew') : t('saveSuccessUpdate'));
        cancelEdit();
        await fetchDocs();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setDocs((d) => d.filter((x) => x.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    }
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size > UPLOAD_MAX_BYTES) {
      toast.error(t('fileTooLarge'));
      return;
    }

    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('knowledge_base_id', kb.id);
      const res = await fetch('/api/ai/knowledge/upload', { method: 'POST', body });
      const data = await res.json();
      if (res.ok) {
        if (data.warning) toast.warning(data.warning);
        else toast.success(t('uploadSuccess'));
        await fetchDocs();
      } else {
        toast.error(data.error ?? t('uploadFailed'));
      }
    } catch {
      toast.error(t('uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(t('reindexSuccess', { count: data.reindexed }));
      } else {
        toast.error(data.error ?? t('reindexFailed'));
      }
    } catch {
      toast.error(t('reindexFailed'));
    } finally {
      setReindexing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <Button
          variant="ghost"
          size="sm"
          className="mb-1 h-7 w-fit px-2 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> {t('backToKbs')}
        </Button>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> {kb.name}
        </CardTitle>
        <CardDescription>{kb.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {docs.length === 0 && editing === null && (
              <p className="text-sm text-muted-foreground">{t('noDocs')}</p>
            )}

            {docs.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {docs.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 truncate text-sm text-foreground">
                      {doc.metadata?.source === 'upload' && (
                        <FileText
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-label={t('sourceUpload')}
                        />
                      )}
                      <span className="truncate">{doc.title}</span>
                    </span>
                    {canEdit && (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => void openEdit(doc.id)}
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(doc.id)}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {editing !== null ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="kb-doc-title">{t('editDocTitle')}</Label>
                  <Input
                    id="kb-doc-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={t('editDocTitlePlaceholder')}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="kb-doc-content">{t('editDocContent')}</Label>
                  <Textarea
                    id="kb-doc-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={t('editDocContentPlaceholder')}
                    rows={8}
                    disabled={saving}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('saveDoc')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={openNew}>
                      <Plus className="mr-2 h-4 w-4" /> {t('addDoc')}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={UPLOAD_ACCEPT}
                      className="hidden"
                      onChange={onPickFile}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                    >
                      {uploading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="mr-2 h-4 w-4" />
                      )}
                      {t('uploadDoc')}
                    </Button>
                  </div>
                  {hasEmbeddingsKey && docs.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={reindex}
                      disabled={reindexing}
                      title={t('reindexTooltip')}
                    >
                      {reindexing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      {t('reindex')}
                    </Button>
                  )}
                </div>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
