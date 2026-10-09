import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  loadPlatformAiConfig: vi.fn(),
  loadPlatformAiRow: vi.fn(),
  loadAiQuota: vi.fn(),
}))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    getCurrentAccount: h.getCurrentAccount,
    requireRole: h.requireRole,
  }
})
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit')
  return { ...actual, checkRateLimit: () => ({ success: true }) }
})
vi.mock('@/lib/ai/platform', () => ({
  loadPlatformAiConfig: h.loadPlatformAiConfig,
  loadPlatformAiRow: h.loadPlatformAiRow,
  loadAiQuota: h.loadAiQuota,
}))

import { GET, POST } from './route'

interface FakeState {
  aiConfigRow: Record<string, unknown> | null
  member: Record<string, unknown> | null
  pipeline: Record<string, unknown> | null
  /** Rows the update "touches"; 0 simulates RLS filtering it out. */
  updatedRows: number
  insertError: { code: string } | null
  updatePayloads: Record<string, unknown>[]
  insertPayloads: Record<string, unknown>[]
}

function fakeSupabase(state: FakeState) {
  return {
    from: (table: string) => {
      if (table === 'ai_configs') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: state.aiConfigRow, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            state.updatePayloads.push(payload)
            return {
              eq: () => ({
                select: () =>
                  Promise.resolve({
                    data: Array.from({ length: state.updatedRows }, () => ({ id: 'cfg-1' })),
                    error: null,
                  }),
              }),
            }
          },
          insert: (payload: Record<string, unknown>) => {
            state.insertPayloads.push(payload)
            return {
              select: () =>
                Promise.resolve(
                  state.insertError
                    ? { data: null, error: state.insertError }
                    : { data: [{ id: 'cfg-new' }], error: null },
                ),
            }
          },
        }
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: state.member, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'pipelines') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: state.pipeline, error: null }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    aiConfigRow: null,
    member: null,
    pipeline: null,
    updatedRows: 1,
    insertError: null,
    updatePayloads: [],
    insertPayloads: [],
    ...overrides,
  }
}

function asAdmin(s: FakeState) {
  h.requireRole.mockResolvedValue({
    supabase: fakeSupabase(s),
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
  })
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const PLATFORM = {
  provider: 'anthropic',
  model: 'claude-test',
  apiKey: 'sk-platform',
  embeddingsApiKey: null,
  embeddingsModel: 'text-embedding-3-small',
}

const ROW = {
  provider: 'openai',
  model: 'gpt-test',
  system_prompt: null,
  is_active: true,
  auto_reply_enabled: true,
  auto_reply_max_per_conversation: 3,
  reply_delay_seconds: 0,
  temperature: 0.7,
  handoff_agent_id: null,
  handoff_on_missing_info: false,
  lead_pipeline_id: 'pipe-1',
  api_key: null,
  embeddings_api_key: null,
  embeddings_model: 'text-embedding-3-small',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.loadPlatformAiConfig.mockResolvedValue(PLATFORM)
  h.loadPlatformAiRow.mockResolvedValue({ provider: 'anthropic', model: 'claude-test' })
  h.loadAiQuota.mockResolvedValue({ limit: 500, used: 12, exceeded: false })
})

describe('GET /api/ai/config', () => {
  it('reports the platform key, its model and the month usage, never a key', async () => {
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase(state({ aiConfigRow: ROW })), accountId: 'acct-1' })
    const json = await (await GET()).json()
    expect(json.key_source).toBe('platform')
    expect(json.model).toBe('claude-test')
    expect(json.monthly_limit).toBe(500)
    expect(json.monthly_used).toBe(12)
    expect(json.handoff_on_missing_info).toBe(false)
    expect(json.lead_pipeline_id).toBe('pipe-1')
    expect(json.api_key).toBeUndefined()
    expect(json.embeddings_api_key).toBeUndefined()
  })

  it('reports an own key with the account model', async () => {
    const row = { ...ROW, api_key: 'enc:sk-own' }
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase(state({ aiConfigRow: row })), accountId: 'acct-1' })
    const json = await (await GET()).json()
    expect(json.key_source).toBe('own')
    expect(json.model).toBe('gpt-test')
    expect(json.api_key).toBeUndefined()
  })

  it('says "none" when there is no row and no platform key', async () => {
    h.loadPlatformAiConfig.mockResolvedValue(null)
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase(state()), accountId: 'acct-1' })
    const json = await (await GET()).json()
    expect(json.configured).toBe(false)
    expect(json.key_source).toBe('none')
  })
})

describe('POST /api/ai/config', () => {
  it('creates the row on the platform key, ignoring any key in the body', async () => {
    const s = state()
    asAdmin(s)
    const res = await post({ is_active: true, api_key: 'sk-sneaky', provider: 'openai' })
    expect(res.status).toBe(200)
    expect(s.insertPayloads[0]).toMatchObject({
      account_id: 'acct-1',
      api_key: null,
      provider: 'anthropic',
      model: 'claude-test',
      is_active: true,
    })
  })

  it('persists an explicit handoff_on_missing_info', async () => {
    const s = state()
    asAdmin(s)
    await post({ handoff_on_missing_info: false })
    expect(s.insertPayloads[0]).toMatchObject({ handoff_on_missing_info: false })
  })

  it('leaves the optional columns out when absent', async () => {
    const s = state({ aiConfigRow: { id: 'cfg-1' } })
    asAdmin(s)
    const res = await post({ is_active: true })
    expect(res.status).toBe(200)
    expect(s.updatePayloads[0]).not.toHaveProperty('handoff_on_missing_info')
    expect(s.updatePayloads[0]).not.toHaveProperty('lead_pipeline_id')
    expect(s.updatePayloads[0]).not.toHaveProperty('api_key')
  })

  it('accepts a pipeline of the account', async () => {
    const s = state({ pipeline: { id: 'pipe-1' } })
    asAdmin(s)
    const res = await post({ lead_pipeline_id: 'pipe-1' })
    expect(res.status).toBe(200)
    expect(s.insertPayloads[0]).toMatchObject({ lead_pipeline_id: 'pipe-1' })
  })

  it('rejects a pipeline of another account', async () => {
    const s = state({ pipeline: null })
    asAdmin(s)
    const res = await post({ lead_pipeline_id: 'someone-elses-pipeline' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('lead_pipeline_id must be a pipeline of this account')
    expect(s.insertPayloads).toHaveLength(0)
  })

  it('treats an empty pipeline as "no lead capture"', async () => {
    const s = state()
    asAdmin(s)
    await post({ lead_pipeline_id: '' })
    expect(s.insertPayloads[0]).toMatchObject({ lead_pipeline_id: null })
  })

  it('answers migration_pending when RLS filters the update out (before 072)', async () => {
    const s = state({ aiConfigRow: { id: 'cfg-1' }, updatedRows: 0 })
    asAdmin(s)
    const res = await post({ is_active: true })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('migration_pending')
  })

  it('answers migration_pending when the NOT NULL key rejects the insert (before 072)', async () => {
    const s = state({ insertError: { code: '23502' } })
    asAdmin(s)
    const res = await post({ is_active: true })
    expect(res.status).toBe(409)
  })
})
