import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { loadLeadDeals } from '@/lib/leads/load'

// Leads → Oportunidades: every deal of the account across all
// pipelines, with its stage, status and source channel. Filtering
// happens on the client. Reads go through the caller's RLS-scoped
// client and are also filtered by account.
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'leads'))) {
      return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
    }
    return NextResponse.json(await loadLeadDeals(supabase, accountId))
  } catch (err) {
    return toErrorResponse(err)
  }
}
