import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  getKnowledgeBaseRoster: vi.fn(),
  getCustomFieldRoster: vi.fn(),
  generateReply: vi.fn(),
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({
  retrieveKnowledge: h.retrieveKnowledge,
  getKnowledgeBaseRoster: h.getKnowledgeBaseRoster,
}))
vi.mock('./custom-fields', () => ({ getCustomFieldRoster: h.getCustomFieldRoster }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))

import { generateWidgetReply } from './widget-reply'

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    replyDelaySeconds: 0,
    temperature: 0.7,
    handoffAgentId: null,
    handoffOnMissingInfo: true,
    leadPipelineId: null,
    embeddingsApiKey: null,
    embeddingsModel: 'text-embedding-3-small',
    ...overrides,
  }
}

function makeDb(state: {
  conv?: Record<string, unknown> | null
  autoResponders?: { id: string }[]
  claim?: boolean
}) {
  const calls = {
    contactUpdates: [] as Record<string, unknown>[],
    noteInserts: [] as Record<string, unknown>[],
    customValueUpserts: [] as Record<string, unknown>[],
    conversationUpdates: [] as Record<string, unknown>[],
    messageInserts: [] as Record<string, unknown>[],
    rpcCalls: [] as { name: string; args: unknown }[],
  }
  const db = {
    from: (table: string) => {
      if (table === 'automations') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () => Promise.resolve({ data: state.autoResponders ?? [], error: null }),
        }
        return chain
      }
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: state.conv ?? null, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            calls.conversationUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'contacts') {
        return {
          update: (payload: Record<string, unknown>) => {
            calls.contactUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'contact_notes') {
        return {
          insert: (payload: Record<string, unknown>) => {
            calls.noteInserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'contact_custom_values') {
        return {
          upsert: (payload: Record<string, unknown>) => {
            calls.customValueUpserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'messages') {
        return {
          insert: (payload: Record<string, unknown>) => {
            calls.messageInserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    rpc: (name: string, args: unknown) => {
      calls.rpcCalls.push({ name, args })
      return Promise.resolve({ data: state.claim ?? true, error: null })
    },
  }
  return { db: db as unknown as SupabaseClient, calls }
}

const ARGS_BASE = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  contactName: 'Juan Perez',
}

beforeEach(() => {
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.getKnowledgeBaseRoster.mockResolvedValue([])
  h.getCustomFieldRoster.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
})

describe('generateWidgetReply — capture side effects', () => {
  it('inserts a note captured via add_note with source "ai"', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, note: 'Prefers email' })
    const { db, calls } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    const res = await generateWidgetReply({ db, ...ARGS_BASE })
    expect(res).toEqual({ ok: true, text: 'Hello!' })
    expect(calls.noteInserts).toEqual([
      {
        contact_id: 'contact-1',
        account_id: 'acct-1',
        user_id: null,
        note_text: 'Prefers email',
        source: 'ai',
      },
    ])
  })

  it('upserts a captured custom field that is in the known roster', async () => {
    h.getCustomFieldRoster.mockResolvedValue([{ id: 'cf-1', field_name: 'Budget' }])
    h.generateReply.mockResolvedValue({
      text: 'Hello!',
      handoff: false,
      customFields: [{ field: 'Budget', value: '$500' }],
    })
    const { db, calls } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    expect(calls.customValueUpserts).toEqual([
      { contact_id: 'contact-1', custom_field_id: 'cf-1', value: '$500' },
    ])
  })

  it('skips a captured custom field that is not in the known roster, without crashing', async () => {
    h.getCustomFieldRoster.mockResolvedValue([{ id: 'cf-1', field_name: 'Budget' }])
    h.generateReply.mockResolvedValue({
      text: 'Hello!',
      handoff: false,
      customFields: [{ field: 'Made Up Field', value: 'x' }],
    })
    const { db, calls } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    const res = await generateWidgetReply({ db, ...ARGS_BASE })
    expect(calls.customValueUpserts).toEqual([])
    expect(res).toEqual({ ok: true, text: 'Hello!' })
  })

  it('persists sentiment to the contact record', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, sentiment: 'negative' })
    const { db, calls } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    expect(calls.contactUpdates).toEqual([
      expect.objectContaining({ ai_sentiment: 'negative' }),
    ])
  })

  it('does not expose set_lead_stage / leadStage capture on the widget path', async () => {
    const { db } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const call = h.generateReply.mock.calls[0][0] as Record<string, unknown>
    expect(call).not.toHaveProperty('leadStageNames')
  })
})

describe('generateWidgetReply — handoff', () => {
  it('disables auto-reply and also inserts the handoff summary as a contact note', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    const { db, calls } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    const res = await generateWidgetReply({ db, ...ARGS_BASE })
    expect(res).toEqual({ ok: false, reason: 'handoff' })
    expect(calls.noteInserts).toHaveLength(1)
    expect(calls.noteInserts[0]).toMatchObject({ contact_id: 'contact-1', source: 'ai' })
    expect(calls.conversationUpdates).toEqual([
      expect.objectContaining({ ai_autoreply_disabled: true }),
    ])
  })
})

describe('generateWidgetReply — handoff_on_missing_info', () => {
  it('includes the "prefer handoff over guessing" clause by default', async () => {
    const { db } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('prefer handing off over guessing')
  })

  it('omits the missing-info handoff clause when handoff_on_missing_info is off', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffOnMissingInfo: false }))
    const { db } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('prefer handing off over guessing')
  })
})
