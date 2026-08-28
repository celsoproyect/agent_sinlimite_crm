import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  getKnowledgeBaseRoster: vi.fn(),
  getCustomFieldRoster: vi.fn(),
  getLeadPipelineStages: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    contact: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    releaseShouldFail: false as boolean,
    updatePayload: null as Record<string, unknown> | null,
    contactUpdatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    noteInserts: [] as Record<string, unknown>[],
    customValueUpserts: [] as Record<string, unknown>[],
    existingDeals: [] as { id: string; status: string }[],
    dealInserts: [] as Record<string, unknown>[],
    dealUpdates: [] as Record<string, unknown>[],
  },
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
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: h.state.contact, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            h.state.contactUpdatePayload = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'contact_notes') {
        return {
          insert: (payload: Record<string, unknown>) => {
            h.state.noteInserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'contact_custom_values') {
        return {
          upsert: (payload: Record<string, unknown>) => {
            h.state.customValueUpserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'deals') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: h.state.existingDeals, error: null }),
              }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            h.state.dealUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
          insert: (payload: Record<string, unknown>) => {
            h.state.dealInserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      if (name === 'release_ai_reply_slot' && h.state.releaseShouldFail) {
        return Promise.resolve({ data: null, error: new Error('boom') })
      }
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

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

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    last_ai_reply_at: null,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.releaseShouldFail = false
  h.state.updatePayload = null
  h.state.contact = { name: null, phone: '+15550001111', ai_sentiment: null }
  h.state.contactUpdatePayload = null
  h.state.rpcCalls = []
  h.state.noteInserts = []
  h.state.customValueUpserts = []
  h.state.existingDeals = []
  h.state.dealInserts = []
  h.state.dealUpdates = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.getKnowledgeBaseRoster.mockResolvedValue([])
  h.getCustomFieldRoster.mockResolvedValue([])
  h.getLeadPipelineStages.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue([
      { content: 'Returns accepted within 30 days.', kbName: 'Legal' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not skip when the per-conversation cap is null (sin límite)', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyMaxPerConversation: null }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 999,
      last_ai_reply_at: null,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.state.rpcCalls[0]).toEqual({
      name: 'claim_ai_reply_slot',
      args: { conversation_id: 'conv-1', max_replies: null },
    })
  })

  it('stamps last_ai_reply_at on the conversation after a successful send', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toHaveProperty('last_ai_reply_at')
  })
})

describe('dispatchInboundToAiReply — reply delay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replies immediately on the first reply, when there is no prior reply to anchor the delay to', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ replyDelaySeconds: 60 }))
    // h.state.conv.last_ai_reply_at is null by default (see beforeEach).
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('replies immediately once the cool-down since the last reply has already elapsed', async () => {
    const conversationId = 'conv-delay-elapsed'
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      last_ai_reply_at: new Date(Date.now() - 120_000).toISOString(),
    }
    h.loadAiConfig.mockResolvedValue(aiConfig({ replyDelaySeconds: 60 }))
    await dispatchInboundToAiReply({ ...ARGS, conversationId })
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('waits out the remaining cool-down before replying', async () => {
    vi.useFakeTimers()
    const conversationId = 'conv-delay-wait'
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      last_ai_reply_at: new Date(Date.now() - 30_000).toISOString(),
    }
    h.loadAiConfig.mockResolvedValue(aiConfig({ replyDelaySeconds: 60 }))

    await dispatchInboundToAiReply({ ...ARGS, conversationId })
    expect(h.engineSendText).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('batches a burst of inbounds during the wait into a single reply', async () => {
    vi.useFakeTimers()
    const conversationId = 'conv-delay-burst'
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      last_ai_reply_at: new Date(Date.now() - 10_000).toISOString(),
    }
    h.loadAiConfig.mockResolvedValue(aiConfig({ replyDelaySeconds: 60 }))

    await dispatchInboundToAiReply({ ...ARGS, conversationId })
    await dispatchInboundToAiReply({ ...ARGS, conversationId }) // second inbound arrives mid-wait
    expect(h.engineSendText).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })
})

describe('dispatchInboundToAiReply — reply-slot release on send failure', () => {
  it('releases the claimed slot when the text send fails', async () => {
    h.engineSendText.mockRejectedValue(new Error('(#100) Invalid parameter'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual([
      'claim_ai_reply_slot',
      'release_ai_reply_slot',
    ])
    expect(h.state.rpcCalls[1].args).toEqual({ conversation_id: 'conv-1' })
  })

  it('does not release the slot when the send succeeds', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual(['claim_ai_reply_slot'])
  })

  it('does not crash the dispatcher when the release call itself fails', async () => {
    h.engineSendText.mockRejectedValue(new Error('send failed'))
    h.state.releaseShouldFail = true
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()
  })
})

describe('dispatchInboundToAiReply — capture side effects', () => {
  it('inserts a note captured via add_note with source "ai"', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, note: 'Wants a callback' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.noteInserts).toEqual([
      {
        contact_id: 'contact-1',
        account_id: 'acct-1',
        user_id: null,
        note_text: 'Wants a callback',
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
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.customValueUpserts).toEqual([
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
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.customValueUpserts).toEqual([])
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('creates a new deal in the lead pipeline when the contact has no existing one', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadPipelineId: 'pipe-1' }))
    h.getLeadPipelineStages.mockResolvedValue([{ id: 'stage-1', name: 'Qualified' }])
    h.state.existingDeals = []
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, leadStage: 'Qualified' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.dealUpdates).toEqual([])
    expect(h.state.dealInserts).toEqual([
      {
        user_id: 'user-1',
        account_id: 'acct-1',
        pipeline_id: 'pipe-1',
        stage_id: 'stage-1',
        contact_id: 'contact-1',
        conversation_id: 'conv-1',
        title: '+15550001111',
        value: 0,
      },
    ])
  })

  it('advances the existing open deal instead of creating a duplicate', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ leadPipelineId: 'pipe-1' }))
    h.getLeadPipelineStages.mockResolvedValue([{ id: 'stage-2', name: 'Won' }])
    h.state.existingDeals = [{ id: 'deal-9', status: 'open' }]
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, leadStage: 'Won' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.dealInserts).toEqual([])
    expect(h.state.dealUpdates).toEqual([
      expect.objectContaining({ stage_id: 'stage-2' }),
    ])
  })

  it('persists sentiment to the contact record', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, sentiment: 'positive' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.contactUpdatePayload).toMatchObject({ ai_sentiment: 'positive' })
    expect(h.state.contactUpdatePayload).toHaveProperty('ai_sentiment_updated_at')
  })

  it('includes the "prefer handoff over guessing" clause when handoff_on_missing_info is on (default)', async () => {
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('prefer handing off over guessing')
  })

  it('omits the missing-info handoff clause when handoff_on_missing_info is off', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffOnMissingInfo: false }))
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('prefer handing off over guessing')
    expect(systemPrompt).toContain('do not hand off for this reason alone')
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('also inserts the handoff summary as a contact note', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.noteInserts).toHaveLength(1)
    expect(h.state.noteInserts[0]).toMatchObject({
      contact_id: 'contact-1',
      source: 'ai',
    })
    expect(h.state.noteInserts[0].note_text).toContain('AI agent handed off')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})
