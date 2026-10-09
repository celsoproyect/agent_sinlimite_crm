import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { pushConfigured, sendPushToUsers } from '@/lib/push/send'

// Send a test notification to every device of the current user.
export async function POST() {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'web_push'))) {
      return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
    }
    if (!pushConfigured()) {
      return NextResponse.json({ error: 'not_configured' }, { status: 503 })
    }
    const result = await sendPushToUsers(accountId, [userId], {
      title: 'Notificación de prueba',
      body: 'Así te avisaremos cuando un cliente quiera hablar con una persona.',
      url: '/notifications',
      tag: 'push-test',
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
