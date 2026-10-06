import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  getKnowledgeBaseRoster: vi.fn(),
  getCustomFieldRoster: vi.fn(),
  getLeadPipelineStages: vi.fn(),
  applyLeadCapture: vi.fn(),
  generateReply: vi.fn(),
  bookingEnabled: vi.fn(),
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({
  retrieveKnowledge: h.retrieveKnowledge,
  getKnowledgeBaseRoster: h.getKnowledgeBaseRoster,
}))
vi.mock('./custom-fields', () => ({
  getCustomFieldRoster: h.getCustomFieldRoster,
  getLeadPipelineStages: h.getLeadPipelineStages,
  applyLeadCapture: h.applyLeadCapture,
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./booking', () => ({
  bookingEnabled: h.bookingEnabled,
  getBusinessHoursSummary: () => Promise.resolve(null),
  checkAvailability: vi.fn(),
  confirmAiBooking: vi.fn(),
  findCustomerBookings: vi.fn(),
  rescheduleAiBooking: vi.fn(),
  cancelAiBooking: vi.fn(),
}))

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
  ownerUserId: 'owner-1',
}

beforeEach(() => {
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.getKnowledgeBaseRoster.mockResolvedValue([])
  h.getCustomFieldRoster.mockResolvedValue([])
  h.getLeadPipelineStages.mockResolvedValue([])
  h.applyLeadCapture.mockReset()
  h.bookingEnabled.mockResolvedValue(false)
  h.generateReply.mockReset()
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

  it('files a captured lead stage and amount into the lead pipeline', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadPipelineId: 'pipe-1' }))
    h.getLeadPipelineStages.mockResolvedValue([{ id: 'stage-1', name: 'Qualified' }])
    h.generateReply.mockResolvedValue({
      text: 'Hello!',
      handoff: false,
      leadStage: 'Qualified',
      leadValue: { amount: 3500, currency: 'DOP' },
    })
    const { db } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const call = h.generateReply.mock.calls[0][0] as Record<string, unknown>
    expect(call.leadStageNames).toEqual(['Qualified'])
    expect(h.applyLeadCapture).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        pipelineId: 'pipe-1',
        ownerUserId: 'owner-1',
        stage: 'Qualified',
        value: { amount: 3500, currency: 'DOP' },
        title: 'Juan Perez',
      }),
    )
  })

  it('does not offer set_lead_stage when no lead pipeline is configured', async () => {
    const { db } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const call = h.generateReply.mock.calls[0][0] as Record<string, unknown>
    expect(call.leadStageNames).toBeUndefined()
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
  it('lists missing information as a handoff reason by default', async () => {
    const { db } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('answering would require information you do not have')
  })

  it('omits the missing-info handoff clause when handoff_on_missing_info is off', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffOnMissingInfo: false }))
    const { db } = makeDb({ conv: { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 } })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('answering would require information you do not have')
    expect(systemPrompt).toContain('that is a normal reply, not a handoff')
  })
})

describe('generateWidgetReply — booking', () => {
  const conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0 }

  it('wires the booking tools and asks for a text list of slots when hours are saved', async () => {
    h.bookingEnabled.mockResolvedValue(true)
    const { db } = makeDb({ conv })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const call = h.generateReply.mock.calls[0][0]
    expect(call.checkAvailability).toBeTypeOf('function')
    expect(call.bookAppointment).toBeTypeOf('function')
    expect(call.manageAppointments).toBeDefined()
    expect(call.systemPrompt).toContain('This chat has no buttons')
    expect(call.systemPrompt).not.toContain('Real WhatsApp buttons')
  })

  it('leaves booking out and forbids promising appointments without saved hours', async () => {
    const { db } = makeDb({ conv })
    await generateWidgetReply({ db, ...ARGS_BASE })
    const call = h.generateReply.mock.calls[0][0]
    expect(call.checkAvailability).toBeUndefined()
    expect(call.bookAppointment).toBeUndefined()
    expect(call.systemPrompt).toContain('You cannot schedule, reserve, or confirm appointments')
  })
})
