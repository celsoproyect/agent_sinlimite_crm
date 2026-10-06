import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { drainPendingAutomations } from '@/lib/automations/drain-pending'

/**
 * Drain due `automation_pending_executions` rows on demand. The server
 * already does it every minute on its own (see `startServerSchedulers`);
 * this endpoint is for an external pinger and requires the shared
 * secret via the `x-cron-secret` header to match `AUTOMATION_CRON_SECRET`.
 * The work itself lives in `drainPendingAutomations`.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    return NextResponse.json({ processed: await drainPendingAutomations(supabaseAdmin()) })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
