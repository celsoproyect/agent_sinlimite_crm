// Client helpers for support mode (migration 073). After the profile
// moves, every cached query in the app belongs to the old account, so
// both actions finish with a full page load instead of a soft refresh.

export type SupportResult = { ok: true } | { ok: false; code?: string; error?: string }

async function call(method: 'POST' | 'DELETE', body?: unknown): Promise<SupportResult> {
  try {
    const res = await fetch('/api/super-admin/support', {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, code: data.code, error: data.error }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Enter a client's account as support, then reload into its dashboard. */
export async function enterAccount(accountId: string): Promise<SupportResult> {
  const result = await call('POST', { account_id: accountId })
  if (result.ok) window.location.assign('/dashboard')
  return result
}

/** Leave support mode, then reload back in Super admin → Cuentas. */
export async function leaveSupport(): Promise<SupportResult> {
  const result = await call('DELETE')
  if (result.ok) window.location.assign('/super-admin?tab=accounts')
  return result
}
