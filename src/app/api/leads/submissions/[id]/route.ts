import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { isMissingTableError } from '@/lib/leads/submissions'

// PATCH { is_read } — mark a form submission read or unread. RLS lets
// agents and up update; a filtered-out update returns 0 rows, so the
// row count is checked.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { supabase, accountId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'leads'))) {
      return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
    }
    let body: { is_read?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    }
    if (typeof body.is_read !== 'boolean') {
      return NextResponse.json({ error: 'is_read must be a boolean' }, { status: 400 })
    }
    const { data, error } = await supabase
      .from('lead_form_submissions')
      .update({ is_read: body.is_read })
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, is_read')
    if (error) {
      if (isMissingTableError(error)) {
        return NextResponse.json({ error: 'not_migrated' }, { status: 503 })
      }
      throw error
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json(data[0])
  } catch (err) {
    return toErrorResponse(err)
  }
}
