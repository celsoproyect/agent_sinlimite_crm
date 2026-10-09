import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

const h = vi.hoisted(() => ({
  loadPlatformAiConfig: vi.fn(),
  loadAiQuota: vi.fn(),
}))
vi.mock('./platform', () => ({
  loadPlatformAiConfig: h.loadPlatformAiConfig,
  loadAiQuota: h.loadAiQuota,
}))

import { loadAiConfig } from './config'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  reply_delay_seconds: 0,
  temperature: 0.7,
  embeddings_api_key: null,
  embeddings_model: 'text-embedding-3-small',
}

const PLATFORM = {
  provider: 'anthropic',
  model: 'claude-x',
  apiKey: 'sk-platform',
  embeddingsApiKey: 'sk-emb',
  embeddingsModel: 'text-embedding-3-large',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.loadPlatformAiConfig.mockResolvedValue(PLATFORM)
  h.loadAiQuota.mockResolvedValue({ limit: null, used: 0, exceeded: false })
})

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
    expect(config!.keySource).toBe('own')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('loadAiConfig platform key (migration 072)', () => {
  const PLATFORM_ROW = { ...ROW, api_key: null, is_active: true }

  it('runs on the platform key and model when the account has no key', async () => {
    const config = await loadAiConfig(dbReturning(PLATFORM_ROW), 'acct')
    expect(config).toMatchObject({
      provider: 'anthropic',
      model: 'claude-x',
      apiKey: 'sk-platform',
      keySource: 'platform',
      embeddingsApiKey: 'sk-emb',
      embeddingsModel: 'text-embedding-3-large',
    })
  })

  it('returns null when there is no platform key either', async () => {
    h.loadPlatformAiConfig.mockResolvedValue(null)
    expect(await loadAiConfig(dbReturning(PLATFORM_ROW), 'acct')).toBeNull()
  })

  it('pauses the AI when the monthly limit is reached', async () => {
    h.loadAiQuota.mockResolvedValue({ limit: 100, used: 100, exceeded: true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await loadAiConfig(dbReturning(PLATFORM_ROW), 'acct')).toBeNull()
  })

  it('never caps an account on its own key', async () => {
    h.loadAiQuota.mockResolvedValue({ limit: 1, used: 50, exceeded: true })
    const config = await loadAiConfig(dbReturning({ ...ROW, is_active: true }), 'acct')
    expect(config?.keySource).toBe('own')
    expect(h.loadAiQuota).not.toHaveBeenCalled()
  })
})
