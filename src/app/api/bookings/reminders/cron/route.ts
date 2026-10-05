import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { drainBookingReminders } from '@/lib/bookings/drain-reminders'

/**
 * Drain due booking reminders on demand. The server already drains them
 * every minute on its own (see `startBookingReminderScheduler`); this
 * endpoint is for an external pinger / Vercel Cron, with the same
 * shared secret as `/api/automations/cron` and `/api/flows/cron` (see
 * docs/docker.md). The work itself lives in `drainBookingReminders`.
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
    return NextResponse.json(await drainBookingReminders(supabaseAdmin()))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
