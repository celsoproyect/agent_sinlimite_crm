import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { pushConfigured, vapidPublicKey } from '@/lib/push/send'

// The VAPID public key the browser subscribes with. Served at runtime
// (not a NEXT_PUBLIC var, which the Docker image bakes at build time).
// `publicKey` is null when the server has no VAPID keys.
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'web_push'))) {
      return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
    }
    return NextResponse.json({ publicKey: pushConfigured() ? vapidPublicKey() : null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
