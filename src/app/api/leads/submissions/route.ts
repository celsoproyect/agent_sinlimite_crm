import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { loadSubmissions } from '@/lib/leads/load'

// Leads → Formularios: every web form submission (migration 070),
// newest first. Answers `{ missing: true }` until the migration runs so
// the page can ask the owner to run it.
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'leads'))) {
      return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
    }
    return NextResponse.json(await loadSubmissions(supabase, accountId))
  } catch (err) {
    return toErrorResponse(err)
  }
}
