import type { DealStatus } from '@/types'

/** Browser side of `/api/deals/[id]/status`: close a deal as won/lost
 *  (with the reason when lost) or reopen it. Throws with the server's
 *  message on failure. */
export async function setDealStatus(
  dealId: string,
  body: { status: DealStatus; lost_reason?: string; note?: string; stage_id?: string },
): Promise<void> {
  const res = await fetch(`/api/deals/${dealId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
}
