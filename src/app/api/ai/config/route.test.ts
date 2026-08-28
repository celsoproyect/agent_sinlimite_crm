import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireSuperAdmin: vi.fn(),
  validateAiCredentials: vi.fn(),
  embedTexts: vi.fn(),
}))

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    getCurrentAccount: h.getCurrentAccount,
    requireSuperAdmin: h.requireSuperAdmin,
  }
})
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit')
  return { ...actual, checkRateLimit: () => ({ success: true }) }
})
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ''),
}))
vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: h.validateAiCredentials }))
vi.mock('@/lib/ai/embeddings', () => ({ embedTexts: h.embedTexts }))

import { GET, POST } from './route'

interface FakeState {
  aiConfigRow: Record<string, unknown> | null
  member: Record<string, unknown> | null
  pipeline: Record<string, unknown> | null
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
            return { eq: () => Promise.resolve({ error: null }) }
          },
          insert: (payload: Record<string, unknown>) => {
            state.insertPayloads.push(payload)
            return Promise.resolve({ error: null })
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
    updatePayloads: [],
    insertPayloads: [],
    ...overrides,
  }
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

beforeEach(() => {
  h.validateAiCredentials.mockResolvedValue(undefined)
  h.embedTexts.mockResolvedValue([[0]])
})

describe('GET /api/ai/config', () => {
  it('returns the new handoff_on_missing_info and lead_pipeline_id columns', async () => {
    const s = state({
      aiConfigRow: {
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
        api_key: 'enc:sk-test',
        embeddings_api_key: null,
        embeddings_model: 'text-embedding-3-small',
      },
    })
    h.getCurrentAccount.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1' })

    const res = await GET()
    const json = await res.json()
    expect(json.handoff_on_missing_info).toBe(false)
    expect(json.lead_pipeline_id).toBe('pipe-1')
    expect(json.api_key).toBeUndefined()
  })
})

describe('POST /api/ai/config — handoff_on_missing_info', () => {
  beforeEach(() => {
    h.requireSuperAdmin.mockImplementation(async () => ({
      supabase: fakeSupabase(state()),
      accountId: 'acct-1',
      userId: 'user-1',
    }))
  })

  it('persists an explicit true', async () => {
    const s = state()
    h.requireSuperAdmin.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1', userId: 'user-1' })
    const res = await post({
      provider: 'openai',
      model: 'gpt-test',
      api_key: 'sk-test',
      handoff_on_missing_info: true,
    })
    expect(res.status).toBe(200)
    expect(s.insertPayloads[0]).toMatchObject({ handoff_on_missing_info: true })
  })

  it('leaves the column out of the insert payload entirely when absent (defaults to the column default)', async () => {
    const s = state()
    h.requireSuperAdmin.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1', userId: 'user-1' })
    const res = await post({ provider: 'openai', model: 'gpt-test', api_key: 'sk-test' })
    expect(res.status).toBe(200)
    expect(s.insertPayloads[0]).not.toHaveProperty('handoff_on_missing_info')
  })

  it('persists an explicit false', async () => {
    const s = state()
    h.requireSuperAdmin.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1', userId: 'user-1' })
    const res = await post({
      provider: 'openai',
      model: 'gpt-test',
      api_key: 'sk-test',
      handoff_on_missing_info: false,
    })
    expect(res.status).toBe(200)
    expect(s.insertPayloads[0]).toMatchObject({ handoff_on_missing_info: false })
  })

  it('leaves the column unchanged on update when the field is absent from the body', async () => {
    const s = state({
      aiConfigRow: { id: 'cfg-1', provider: 'openai', model: 'gpt-test', api_key: 'enc:sk-test' },
    })
    h.requireSuperAdmin.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1', userId: 'user-1' })
    const res = await post({ provider: 'openai', model: 'gpt-test' })
    expect(res.status).toBe(200)
    expect(s.updatePayloads[0]).not.toHaveProperty('handoff_on_missing_info')
  })
})

describe('POST /api/ai/config — lead_pipeline_id', () => {
  it('accepts a pipeline that belongs to the account', async () => {
    const s = state({ pipeline: { id: 'pipe-1' } })
    h.requireSuperAdmin.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1', userId: 'user-1' })
    const res = await post({
      provider: 'openai',
      model: 'gpt-test',
      api_key: 'sk-test',
      lead_pipeline_id: 'pipe-1',
    })
    expect(res.status).toBe(200)
    expect(s.insertPayloads[0]).toMatchObject({ lead_pipeline_id: 'pipe-1' })
  })

  it('rejects a pipeline that does not belong to the account', async () => {
    const s = state({ pipeline: null })
    h.requireSuperAdmin.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1', userId: 'user-1' })
    const res = await post({
      provider: 'openai',
      model: 'gpt-test',
      api_key: 'sk-test',
      lead_pipeline_id: 'someone-elses-pipeline',
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('lead_pipeline_id must be a pipeline of this account')
    expect(s.insertPayloads).toHaveLength(0)
  })

  it('treats an empty string as "no lead capture"', async () => {
    const s = state()
    h.requireSuperAdmin.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1', userId: 'user-1' })
    const res = await post({
      provider: 'openai',
      model: 'gpt-test',
      api_key: 'sk-test',
      lead_pipeline_id: '',
    })
    expect(res.status).toBe(200)
    expect(s.insertPayloads[0]).toMatchObject({ lead_pipeline_id: null })
  })

  it('leaves the column unchanged on update when the field is absent from the body', async () => {
    const s = state({
      aiConfigRow: { id: 'cfg-1', provider: 'openai', model: 'gpt-test', api_key: 'enc:sk-test' },
    })
    h.requireSuperAdmin.mockResolvedValue({ supabase: fakeSupabase(s), accountId: 'acct-1', userId: 'user-1' })
    const res = await post({ provider: 'openai', model: 'gpt-test' })
    expect(res.status).toBe(200)
    expect(s.updatePayloads[0]).not.toHaveProperty('lead_pipeline_id')
  })
})
