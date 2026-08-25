"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type {
  Contact,
  Deal,
  ContactNote,
  Tag,
  CustomField,
  ContactCustomValue,
  Booking,
} from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  CalendarClock,
  ClipboardList,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format } from "date-fns";
import { useTranslations } from "next-intl";

interface ContactSidebarProps {
  contact: Contact | null;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [nextBooking, setNextBooking] = useState<Booking | null>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<ContactCustomValue[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    const [dealsRes, notesRes, tagsRes, bookingRes, customFieldsRes, customValuesRes] =
      await Promise.all([
        supabase
          .from("deals")
          .select("*, stage:pipeline_stages(*)")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_notes")
          .select("*")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_tags")
          .select("id, tag_id, tags(*)")
          .eq("contact_id", contact.id),
        supabase
          .from("bookings")
          .select("*")
          .eq("contact_id", contact.id)
          .eq("status", "confirmed")
          .gte("starts_at", new Date().toISOString())
          .order("starts_at", { ascending: true })
          .limit(1)
          .maybeSingle(),
        accountId
          ? supabase.from("custom_fields").select("*").eq("account_id", accountId)
          : Promise.resolve({ data: [] as CustomField[] }),
        supabase
          .from("contact_custom_values")
          .select("*")
          .eq("contact_id", contact.id),
      ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
    setNextBooking(bookingRes.data ?? null);
    if (customFieldsRes.data) setCustomFields(customFieldsRes.data);
    if (customValuesRes.data) setCustomValues(customValuesRes.data);
  }, [contact, accountId]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  // Full account tag list for the "+" add-tag picker — loaded once per
  // account, independent of which contact is open (mirrors the same
  // account-scoped fetch `ConversationList` already does for its filter).
  const [accountTags, setAccountTags] = useState<Tag[]>([]);
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setAccountTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const availableTags = useMemo(() => {
    const appliedIds = new Set(tags.map((t) => t.id));
    return accountTags.filter((t) => !appliedIds.has(t.id));
  }, [accountTags, tags]);

  const handleAddTag = useCallback(
    async (tagId: string) => {
      if (!contact) return;
      const supabase = createClient();
      const { data, error } = await supabase
        .from("contact_tags")
        .insert({ contact_id: contact.id, tag_id: tagId })
        .select("id, tag_id, tags(*)")
        .single();
      if (!error && data?.tags) {
        setTags((prev) => [
          ...prev,
          { ...(data.tags as unknown as Tag), contact_tag_id: data.id as string },
        ]);
      }
    },
    [contact],
  );

  const handleCustomValueChange = useCallback(
    async (fieldId: string, value: string) => {
      if (!contact) return;
      setCustomValues((prev) => {
        const existing = prev.find((v) => v.custom_field_id === fieldId);
        if (existing) {
          return prev.map((v) =>
            v.custom_field_id === fieldId ? { ...v, value } : v,
          );
        }
        return [...prev, { id: "", contact_id: contact.id, custom_field_id: fieldId, value }];
      });

      const supabase = createClient();
      await supabase
        .from("contact_custom_values")
        .upsert(
          { contact_id: contact.id, custom_field_id: fieldId, value },
          { onConflict: "contact_id,custom_field_id" },
        );
    },
    [contact],
  );

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <TagIcon className="h-3 w-3" />
                {tSidebar("tags")}
              </div>
              {availableTags.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={tSidebar("addTag")}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3 w-3" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-64 w-48 border-border bg-popover">
                    {availableTags.map((tag) => (
                      <DropdownMenuItem
                        key={tag.id}
                        onClick={() => handleAddTag(tag.id)}
                        className="text-sm text-popover-foreground"
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: tag.color }}
                          />
                          <span className="truncate">{tag.name}</span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[0.625rem] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Lead status — a single primary deal card (most recent open
              deal, falling back to the most recent deal overall) instead
              of the full deal list a solo-agent account has no use for. */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2">
              {(() => {
                const primaryDeal = deals.find((d) => d.status === "open") ?? deals[0];
                if (!primaryDeal) {
                  return <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>;
                }
                return (
                  <div className="rounded-lg bg-muted px-3 py-2">
                    <p className="text-sm font-medium text-foreground">
                      {primaryDeal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {primaryDeal.currency ?? "$"}
                        {primaryDeal.value.toLocaleString()}
                      </span>
                      {primaryDeal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[0.625rem]"
                          style={{
                            backgroundColor: `${primaryDeal.stage.color}20`,
                            color: primaryDeal.stage.color,
                          }}
                        >
                          {primaryDeal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Next booking */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <CalendarClock className="h-3 w-3" />
              {tSidebar("nextBooking")}
            </div>
            <div className="mt-2">
              {nextBooking ? (
                <div className="rounded-lg bg-muted px-3 py-2">
                  <p className="text-sm font-medium text-foreground">
                    {nextBooking.service || tSidebar("nextBooking")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {format(new Date(nextBooking.starts_at), "MMM d, yyyy HH:mm")}
                  </p>
                </div>
              ) : (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noUpcomingBooking")}</p>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Captured data — key/value block over custom_fields, edited
              inline directly against contact_custom_values. */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <ClipboardList className="h-3 w-3" />
              {tSidebar("capturedData")}
            </div>
            <div className="mt-2 space-y-2">
              {customFields.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noCapturedData")}</p>
              ) : (
                customFields.map((field) => {
                  const current = customValues.find((v) => v.custom_field_id === field.id)?.value ?? "";
                  return (
                    <div key={field.id} className="px-1">
                      <label className="text-[0.625rem] text-muted-foreground">{field.field_name}</label>
                      <input
                        defaultValue={current}
                        onBlur={(e) => {
                          if (e.target.value !== current) {
                            handleCustomValueChange(field.id, e.target.value);
                          }
                        }}
                        className="mt-0.5 w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground outline-none focus:border-primary/50"
                      />
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[0.625rem] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
