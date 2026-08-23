'use client';

// ============================================================
// UsersPanel — /super-admin → Users
//
// Cross-account user management for the super admin: add a user
// directly to any client's account, edit their name/role/account,
// reset their password, or delete them outright.
//
// This is a platform-level surface, not the per-account Members
// tab (src/components/settings/members-tab.tsx) — every write here
// crosses account boundaries via the service-role client on the
// server, gated by requireSuperAdmin(). `is_super_admin` itself is
// never editable from this panel (see the API route header comment)
// — a badge shows it, nothing more.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import type { AccountRole } from '@/lib/auth/roles';
import { ROLE_META } from '@/components/settings/role-meta';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

interface PlatformUser {
  user_id: string;
  full_name: string;
  email: string | null;
  account_id: string;
  account_name: string;
  role: AccountRole;
  is_super_admin: boolean;
  created_at: string;
}

interface AccountOption {
  id: string;
  name: string;
}

type AssignableRole = Exclude<AccountRole, 'owner'>;
const ASSIGNABLE_ROLES: AssignableRole[] = ['admin', 'agent', 'viewer'];

interface CreateForm {
  full_name: string;
  email: string;
  password: string;
  account_id: string;
  role: AssignableRole;
}

const EMPTY_CREATE_FORM: CreateForm = {
  full_name: '',
  email: '',
  password: '',
  account_id: '',
  role: 'agent',
};

interface EditForm {
  full_name: string;
  account_id: string;
  role: AssignableRole;
  password: string;
}

export function UsersPanel() {
  const t = useTranslations('SuperAdmin.users');
  const tRoles = useTranslations('Settings.roles');
  const { user } = useAuth();

  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [creating, setCreating] = useState(false);

  const [editingUser, setEditingUser] = useState<PlatformUser | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);

  const [deletingUser, setDeletingUser] = useState<PlatformUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadEverything = useCallback(async () => {
    try {
      const [uRes, aRes] = await Promise.all([
        fetch('/api/super-admin/users', { cache: 'no-store' }),
        fetch('/api/super-admin/accounts', { cache: 'no-store' }),
      ]);
      if (!uRes.ok) {
        const payload = await uRes.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const uData = (await uRes.json()) as { users: PlatformUser[] };
      setUsers(uData.users);

      if (aRes.ok) {
        const aData = (await aRes.json()) as { accounts: AccountOption[] };
        setAccounts(aData.accounts);
      }
    } catch (err) {
      console.error('[UsersPanel] load error:', err);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadEverything();
  }, [loadEverything]);

  function openCreate() {
    setCreateForm({
      ...EMPTY_CREATE_FORM,
      account_id: accounts[0]?.id ?? '',
    });
    setCreateOpen(true);
  }

  async function handleCreate() {
    const fullName = createForm.full_name.trim();
    const email = createForm.email.trim();
    if (!fullName) return toast.error(t('fullNameRequired'));
    if (!email || !email.includes('@')) return toast.error(t('emailInvalid'));
    if (createForm.password.length < 8) return toast.error(t('passwordTooShort'));
    if (!createForm.account_id) return toast.error(t('accountRequired'));

    setCreating(true);
    try {
      const res = await fetch('/api/super-admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName,
          email,
          password: createForm.password,
          account_id: createForm.account_id,
          role: createForm.role,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t('createFailed'));
      toast.success(t('createdToast', { name: fullName }));
      setCreateOpen(false);
      await loadEverything();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('createFailed'));
    } finally {
      setCreating(false);
    }
  }

  function openEdit(target: PlatformUser) {
    setEditingUser(target);
    setEditForm({
      full_name: target.full_name,
      account_id: target.account_id,
      role: target.role === 'owner' ? 'admin' : target.role,
      password: '',
    });
  }

  async function handleSaveEdit() {
    if (!editingUser || !editForm) return;
    const fullName = editForm.full_name.trim();
    if (!fullName) return toast.error(t('fullNameRequired'));
    if (editForm.password && editForm.password.length < 8) {
      return toast.error(t('passwordTooShort'));
    }

    const isOwnerRow = editingUser.role === 'owner';
    const body: Record<string, unknown> = { full_name: fullName };
    if (!isOwnerRow) {
      body.role = editForm.role;
      body.account_id = editForm.account_id;
    }
    if (editForm.password) body.password = editForm.password;

    setSaving(true);
    try {
      const res = await fetch(`/api/super-admin/users/${editingUser.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t('updateFailed'));
      toast.success(t('updatedToast', { name: fullName }));
      setEditingUser(null);
      setEditForm(null);
      await loadEverything();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('updateFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deletingUser) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/super-admin/users/${deletingUser.user_id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t('deleteFailed'));
      toast.success(t('deletedToast', { name: deletingUser.full_name || t('unnamed') }));
      setUsers((prev) => prev.filter((u) => u.user_id !== deletingUser.user_id));
      setDeletingUser(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <Button onClick={openCreate} disabled={accounts.length === 0}>
            <Plus className="size-4" />
            {t('addUser')}
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <UsersRound className="size-6 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">{t('noUsers')}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {users.map((u) => {
                const roleMeta = ROLE_META[u.role];
                const RoleIcon = roleMeta.icon;
                const isSelf = u.user_id === user?.id;
                return (
                  <li
                    key={u.user_id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {u.full_name || t('unnamed')}
                        </span>
                        {u.is_super_admin && (
                          <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                            <ShieldAlert className="size-3" />
                            {t('superAdminBadge')}
                          </span>
                        )}
                        {isSelf && (
                          <Badge className="border-border bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">
                            {t('you')}
                          </Badge>
                        )}
                      </div>
                      {u.email && (
                        <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                      )}
                    </div>

                    <div className="text-xs text-muted-foreground sm:w-40 sm:shrink-0">
                      {u.account_name}
                    </div>

                    <span
                      className={`inline-flex w-fit items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${roleMeta.className}`}
                    >
                      <RoleIcon className="size-3.5" />
                      {tRoles(u.role)}
                    </span>

                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => openEdit(u)}>
                        <Pencil className="size-4" />
                      </Button>
                      {!isSelf && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDeletingUser(u)}
                          className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 hover:text-red-200"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('createDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('createDialogDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('fullNameLabel')}</Label>
              <Input
                value={createForm.full_name}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, full_name: e.target.value }))
                }
                className="bg-muted border-border text-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('emailLabel')}</Label>
              <Input
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                className="bg-muted border-border text-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('passwordLabel')}</Label>
              <Input
                type="text"
                value={createForm.password}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, password: e.target.value }))
                }
                className="bg-muted border-border text-foreground font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">{t('passwordHint')}</p>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('accountLabel')}</Label>
              <Select
                value={createForm.account_id}
                onValueChange={(v) => v && setCreateForm((f) => ({ ...f, account_id: v }))}
              >
                <SelectTrigger className="w-full bg-muted border-border text-foreground">
                  <SelectValue>
                    {accounts.find((a) => a.id === createForm.account_id)?.name ??
                      t('accountPlaceholder')}
                  </SelectValue>
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
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('roleLabel')}</Label>
              <Select
                value={createForm.role}
                onValueChange={(v) =>
                  v && setCreateForm((f) => ({ ...f, role: v as AssignableRole }))
                }
              >
                <SelectTrigger className="w-full bg-muted border-border text-foreground">
                  <SelectValue>{tRoles(createForm.role)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ASSIGNABLE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {tRoles(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('creating')}
                </>
              ) : (
                t('create')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editingUser !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingUser(null);
            setEditForm(null);
          }
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('editDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('editDialogDesc')}
            </DialogDescription>
          </DialogHeader>

          {editForm && editingUser && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('fullNameLabel')}</Label>
                <Input
                  value={editForm.full_name}
                  onChange={(e) =>
                    setEditForm((f) => (f ? { ...f, full_name: e.target.value } : f))
                  }
                  className="bg-muted border-border text-foreground"
                />
              </div>

              {editingUser.role === 'owner' ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  {t('ownerHint')}
                </p>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">{t('accountLabel')}</Label>
                    <Select
                      value={editForm.account_id}
                      onValueChange={(v) =>
                        v && setEditForm((f) => (f ? { ...f, account_id: v } : f))
                      }
                    >
                      <SelectTrigger className="w-full bg-muted border-border text-foreground">
                        <SelectValue>
                          {accounts.find((a) => a.id === editForm.account_id)?.name ?? ''}
                        </SelectValue>
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
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">{t('roleLabel')}</Label>
                    <Select
                      value={editForm.role}
                      onValueChange={(v) =>
                        v &&
                        setEditForm((f) =>
                          f ? { ...f, role: v as AssignableRole } : f,
                        )
                      }
                    >
                      <SelectTrigger className="w-full bg-muted border-border text-foreground">
                        <SelectValue>{tRoles(editForm.role)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {ASSIGNABLE_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {tRoles(r)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label className="flex items-center gap-1.5 text-muted-foreground">
                  <KeyRound className="size-3.5" />
                  {t('resetPasswordLabel')}
                </Label>
                <Input
                  type="text"
                  placeholder={t('newPasswordPlaceholder')}
                  value={editForm.password}
                  onChange={(e) =>
                    setEditForm((f) => (f ? { ...f, password: e.target.value } : f))
                  }
                  className="bg-muted border-border text-foreground font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">{t('leaveBlankHint')}</p>
              </div>
            </div>
          )}

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => {
                setEditingUser(null);
                setEditForm(null);
              }}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button onClick={handleSaveEdit} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('saveChanges')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deletingUser !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingUser(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('deleteDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t.rich('deleteDialogDesc', {
                name: deletingUser?.full_name || t('unnamed'),
                bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeletingUser(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('deleteBtn')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
