import { AiError, type AiUsage, type ChatMessage } from '../types'
import type { KnowledgeExcerpt, KnowledgeBaseSummary } from '../knowledge'

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

/** The `search_knowledge_base` function/tool both adapters expose to the
 *  model, and how to run it. `knowledgeBases` becomes the tool's
 *  `knowledge_base` enum (which collection to target); `execute` is a
 *  thin wrapper around `retrieveKnowledgeFromKb` supplied by the caller
 *  (generate.ts), so this module never touches the DB directly. */
export interface KnowledgeSearchTool {
  knowledgeBases: KnowledgeBaseSummary[]
  execute: (args: { query: string; knowledgeBaseName?: string }) => Promise<KnowledgeExcerpt[]>
}

export const KNOWLEDGE_SEARCH_TOOL_NAME = 'search_knowledge_base'

/** Tool-call rounds allowed before the adapter forces a final,
 *  tool-free round to guarantee text comes back. */
export const MAX_TOOL_ROUNDS = 2

/** Serialize excerpts for a tool result message — the model sees them
 *  the same way it sees the automatically-retrieved excerpts (title
 *  included, for internal attribution only; buildSystemPrompt already
 *  instructs it never to surface a title/source to the customer). */
export function excerptsToToolResult(excerpts: KnowledgeExcerpt[]): string {
  if (excerpts.length === 0) return JSON.stringify({ results: [], note: 'No matching excerpts found.' })
  return JSON.stringify({
    results: excerpts.map((e) => ({ collection: e.kbName, title: e.title, content: e.content })),
  })
}

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
  /** When present, the adapter exposes `search_knowledge_base` to the
   *  model and runs its own internal multi-round tool-call loop. */
  tool?: KnowledgeSearchTool
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
