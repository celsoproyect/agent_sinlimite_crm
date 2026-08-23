import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for cross-account super admin
// operations (user create/edit/delete, account listing). Mirrors
// src/lib/flows/admin-client.ts / src/lib/automations/admin-client.ts
// — same shape so anyone reading either file picks up the convention
// immediately.
//
// Every route that calls this MUST gate on requireSuperAdmin() first
// (using the caller's own RLS-scoped client) — this client bypasses
// RLS entirely, so it is the thing being gated, not a gate itself.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
