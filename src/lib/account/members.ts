import type { AccountMember } from '@/types';

/**
 * Fetch the current account's members from the API (which applies the
 * email-visibility rules — agents/viewers don't see emails). Best-effort:
 * returns `[]` on any error or on an older deployment without the
 * endpoint, so callers can fall back to a queue-only / raw-id picker.
 *
 * Client-side only (uses `fetch` against the relative API route).
 */
export async function fetchAccountMembers(): Promise<AccountMember[]> {
  try {
    const res = await fetch('/api/account/members', { cache: 'no-store' });
    if (!res.ok) return [];
    const json = (await res.json()) as { members?: AccountMember[] };
    return json.members ?? [];
  } catch {
    return [];
  }
}

/** Display label for a member: full name → email → raw id. */
export function memberLabel(m: AccountMember): string {
  return m.full_name || m.email || m.user_id;
}

/**
 * Keep only the profiles that are part of the account's team, using the
 * members API (which leaves out a super admin visiting in support mode).
 * When the members list is empty (error, older deployment) the profiles
 * pass through unchanged.
 */
export function teamProfiles<T extends { user_id: string }>(
  profiles: T[],
  members: AccountMember[],
): T[] {
  if (members.length === 0) return profiles;
  const ids = new Set(members.map((m) => m.user_id));
  return profiles.filter((p) => ids.has(p.user_id));
}
