import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
  EMBEDDING_MODEL: 'text-embedding-3-small',
}))

import { retrieveKnowledge, retrieveKnowledgeFromKb, ingestDocument } from './knowledge'

interface FakeState {
  semantic: { id: string; content: string; kb_name: string; doc_title?: string | null }[]
  fts: { id: string; content: string; kb_name: string; doc_title?: string | null }[]
  chunkCount: number
  rpcCalls: string[]
  rpcArgs: Record<string, unknown>[]
  inserted: Record<string, unknown>[] | null
  deletedFor: string | null
  kb: { id: string; name: string } | null
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 5, // account has a non-empty KB by default
    rpcCalls: [],
    rpcArgs: [],
    inserted: null,
    deletedFor: null,
    kb: null,
  }
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push(name)
      state.rpcArgs.push(args)
      if (name === 'match_ai_knowledge_semantic')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts')
        return Promise.resolve({ data: state.fts, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard AND
      // retrieveKnowledgeFromKb's name→id lookup share this chain: `eq()`
      // is thenable (resolves the count-guard shape) and also exposes
      // `.ilike().maybeSingle()` for the KB name lookup.
      select: () => ({
        eq: () => ({
          then: (resolve: (v: { count: number; error: null }) => void) =>
            resolve({ count: state.chunkCount, error: null }),
          ilike: (_col: string, name: string) => ({
            maybeSingle: () =>
              Promise.resolve({
                data: state.kb && state.kb.name.toLowerCase() === name.toLowerCase() ? state.kb : null,
                error: null,
              }),
          }),
        }),
      }),
      delete: () => ({
        eq: (_col: string, val: string) => {
          state.deletedFor = val
          return Promise.resolve({ error: null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, '  ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q')
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1', kb_name: 'General', doc_title: 'Doc F' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'q')
    expect(out).toEqual([{ content: 'F1', kbName: 'General', title: 'Doc F' }])
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1', kb_name: 'Legal', doc_title: 'Doc A' },
      { id: 's2', content: 'S2', kb_name: 'Legal', doc_title: 'Doc A' },
      { id: 's3', content: 'S3', kb_name: 'Sales', doc_title: 'Doc B' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual([
      { content: 'S1', kbName: 'Legal', title: 'Doc A' },
      { content: 'S2', kbName: 'Legal', title: 'Doc A' },
      { content: 'S3', kbName: 'Sales', title: 'Doc B' },
    ])
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    // Enough semantic hits → no FTS top-up.
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_semantic'])
  })

  it('tops up with FTS and dedupes when semantic is short', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1', kb_name: 'Legal', doc_title: 'Doc A' },
      { id: 's2', content: 'S2', kb_name: 'Legal', doc_title: 'Doc A' },
    ]
    state.fts = [
      { id: 's2', content: 'S2-dup', kb_name: 'Legal', doc_title: 'Doc A' }, // dedup by id
      { id: 'f1', content: 'F1', kb_name: 'Sales', doc_title: 'Doc B' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual([
      { content: 'S1', kbName: 'Legal', title: 'Doc A' },
      { content: 'S2', kbName: 'Legal', title: 'Doc A' },
      { content: 'F1', kbName: 'Sales', title: 'Doc B' },
    ])
    expect(state.rpcCalls).toEqual([
      'match_ai_knowledge_semantic',
      'match_ai_knowledge_fts',
    ])
  })
})

describe('retrieveKnowledgeFromKb', () => {
  it('returns [] when the KB name does not resolve', async () => {
    const { db, state } = makeDb()
    state.kb = null
    const out = await retrieveKnowledgeFromKb(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 'Unknown KB')
    expect(out).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('resolves a KB by case-insensitive name and filters the RPCs by id', async () => {
    const { db, state } = makeDb()
    state.kb = { id: 'kb-123', name: 'Legal' }
    state.semantic = [{ id: 's1', content: 'S1', kb_name: 'Legal', doc_title: 'Doc A' }]
    const out = await retrieveKnowledgeFromKb(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 'legal')
    expect(out).toEqual([{ content: 'S1', kbName: 'Legal', title: 'Doc A' }])
    expect(state.rpcArgs[0]).toMatchObject({ p_knowledge_base_id: 'kb-123' })
  })

  it('accepts a raw KB id without a name lookup', async () => {
    const { db, state } = makeDb()
    const id = '11111111-2222-3333-4444-555555555555'
    state.semantic = [{ id: 's1', content: 'S1', kb_name: 'Legal', doc_title: 'Doc A' }]
    const out = await retrieveKnowledgeFromKb(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', id)
    expect(out).toEqual([{ content: 'S1', kbName: 'Legal', title: 'Doc A' }])
    expect(state.rpcArgs[0]).toMatchObject({ p_knowledge_base_id: id })
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'kb-1', 'hello world')
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
    expect(state.inserted![0].knowledge_base_id).toBe('kb-1')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'kb-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'kb-1', '   ')
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))
    await expect(
      ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'kb-1', 'hello world'),
    ).rejects.toThrow('rate limited')
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })
})
