'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, Pencil, Paperclip, Upload, Image as ImageIcon, FileText } from 'lucide-react';
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
import { uploadAccountMedia, MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';

interface AttachmentSummary {
  id: string;
  name: string;
  description: string;
  kind: 'image' | 'document';
  mediaUrl: string;
  filename: string;
  mimeType: string;
  updatedAt: string;
}

/** Editor target: 'new' when creating (with a staged file), an
 *  attachment id when editing name/description, null when closed. */
type EditTarget = 'new' | string | null;

export function AiAttachmentsCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Settings.aiAttachments');
  const [items, setItems] = useState<AttachmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/attachments');
      const data = await res.json();
      if (res.ok) setItems(data.attachments ?? []);
      else toast.error(data.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchItems();
  }, [accountId, fetchItems]);

  const openNew = () => {
    setEditing('new');
    setName('');
    setDescription('');
    setFile(null);
  };

  const openEdit = (item: AttachmentSummary) => {
    setEditing(item.id);
    setName(item.name);
    setDescription(item.description);
    setFile(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setName('');
    setDescription('');
    setFile(null);
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    if (picked.size > MEDIA_MAX_BYTES) {
      toast.error(t('fileTooLarge'));
      return;
    }
    setFile(picked);
  };

  const save = async () => {
    if (!name.trim() || !description.trim()) {
      toast.error(t('nameDescriptionRequired'));
      return;
    }
    const isNew = editing === 'new';
    if (isNew && !file) {
      toast.error(t('fileRequired'));
      return;
    }
    setSaving(true);
    try {
      if (isNew && file) {
        const { publicUrl } = await uploadAccountMedia('chat-media', file);
        const kind = file.type.startsWith('image/') ? 'image' : 'document';
        const res = await fetch('/api/ai/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            kind,
            mediaUrl: publicUrl,
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
          }),
        });
        const data = await res.json();
        if (res.ok) {
          toast.success(t('saveSuccessNew'));
          cancelEdit();
          await fetchItems();
        } else {
          toast.error(data.error ?? t('saveFailed'));
        }
      } else {
        const res = await fetch(`/api/ai/attachments/${editing}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), description: description.trim() }),
        });
        const data = await res.json();
        if (res.ok) {
          toast.success(t('saveSuccessUpdate'));
          cancelEdit();
          await fetchItems();
        } else {
          toast.error(data.error ?? t('saveFailed'));
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: AttachmentSummary) => {
    if (!window.confirm(t('deleteConfirm', { name: item.name }))) return;
    try {
      const res = await fetch(`/api/ai/attachments/${item.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setItems((list) => list.filter((x) => x.id !== item.id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Paperclip className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : (
          <>
            {items.length === 0 && editing === null && (
              <p className="text-sm text-muted-foreground">{t('noAttachments')}</p>
            )}

            {items.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {item.kind === 'image' ? (
                        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {item.name}
                        </span>
                        <span className="line-clamp-1 text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                    </span>
                    {canEdit && (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => openEdit(item)}
                          title={t('editAttachment')}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(item)}
                          title={t('deleteAttachment')}
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
                <p className="text-sm font-medium text-foreground">
                  {editing === 'new' ? t('addAttachment') : t('editAttachmentFormTitle')}
                </p>
                <div className="space-y-2">
                  <Label htmlFor="attachment-name">{t('nameLabel')}</Label>
                  <Input
                    id="attachment-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('namePlaceholder')}
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="attachment-description">{t('descriptionLabel')}</Label>
                  <Textarea
                    id="attachment-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('descriptionPlaceholder')}
                    rows={2}
                    disabled={saving}
                  />
                  <p className="text-xs text-muted-foreground">{t('descriptionHint')}</p>
                </div>
                {editing === 'new' && (
                  <div className="space-y-2">
                    <Label>{t('fileLabel')}</Label>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={onPickFile}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={saving}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      {file ? file.name : t('chooseFile')}
                    </Button>
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                    {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('saveAttachment')}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <Button variant="outline" size="sm" onClick={openNew}>
                  <Plus className="mr-2 h-4 w-4" /> {t('addAttachment')}
                </Button>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
