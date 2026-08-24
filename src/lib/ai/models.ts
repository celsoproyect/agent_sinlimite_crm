// ============================================================
// Curated OpenAI model catalog for the settings UI.
//
// Chat models stay a picklist (not free text) only for OpenAI — model
// IDs churn fast, but a picklist avoids typos and lets the UI show a
// friendly label. Anthropic keeps the free-text input in
// ai-config.tsx; this file only covers what the user asked for.
//
// Embeddings models are constrained by the fixed `vector(1536)` column
// (migration 030) — changing it is a destructive migration + full
// re-embed + index rebuild, so every option here must resolve to 1536
// dimensions. OpenAI's `dimensions` request parameter lets
// text-embedding-3-{small,large} truncate their native output to
// 1536; ada-002 has no `dimensions` support and is 1536 natively.
// ============================================================

export interface OpenAiChatModel {
  id: string
  label: string
  /** Whether the model accepts image content blocks. Text-only models
   *  (o1-mini) get a text placeholder substituted in for any image
   *  instead of a failed request — see providers/openai.ts. */
  supportsVision: boolean
}

export interface OpenAiEmbeddingModel {
  id: string
  label: string
  /** Forced output width — always 1536 here (see module comment). */
  dimensions: number
  /** Whether to send `dimensions` in the request body. Only the
   *  text-embedding-3-* family supports the parameter; ada-002 must
   *  omit it and relies on its native 1536-dim output. */
  supportsDimensionsParam: boolean
}

export const OPENAI_CHAT_MODELS: OpenAiChatModel[] = [
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini (balanced, default)', supportsVision: true },
  { id: 'gpt-5.4', label: 'GPT-5.4 (most capable)', supportsVision: true },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano (cheapest)', supportsVision: true },
  { id: 'gpt-5', label: 'GPT-5', supportsVision: true },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini', supportsVision: true },
  { id: 'gpt-5-nano', label: 'GPT-5 Nano', supportsVision: true },
  { id: 'o4-mini', label: 'o4-mini (reasoning)', supportsVision: true },
  { id: 'o3', label: 'o3 (reasoning)', supportsVision: true },
  { id: 'o3-mini', label: 'o3-mini (reasoning)', supportsVision: false },
  { id: 'o1', label: 'o1 (reasoning)', supportsVision: true },
  { id: 'o1-mini', label: 'o1-mini (reasoning)', supportsVision: false },
  { id: 'gpt-4.1', label: 'GPT-4.1', supportsVision: true },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', supportsVision: true },
  { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', supportsVision: true },
  { id: 'gpt-4o', label: 'GPT-4o', supportsVision: true },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', supportsVision: true },
]

export function findChatModel(id: string): OpenAiChatModel | undefined {
  return OPENAI_CHAT_MODELS.find((m) => m.id === id)
}

/** Anthropic keeps a free-text model input (see ai-config.tsx), so there's
 *  no picklist to check — every current Claude model supports vision. */
export function modelSupportsVision(provider: AiProviderLike, model: string): boolean {
  if (provider === 'anthropic') return true
  return findChatModel(model)?.supportsVision ?? false
}

type AiProviderLike = 'openai' | 'anthropic'

export const OPENAI_EMBEDDING_MODELS: OpenAiEmbeddingModel[] = [
  {
    id: 'text-embedding-3-small',
    label: 'text-embedding-3-small (recommended)',
    dimensions: 1536,
    supportsDimensionsParam: true,
  },
  {
    id: 'text-embedding-3-large',
    label: 'text-embedding-3-large (higher quality, slower)',
    dimensions: 1536,
    supportsDimensionsParam: true,
  },
  {
    id: 'text-embedding-ada-002',
    label: 'text-embedding-ada-002 (legacy)',
    dimensions: 1536,
    supportsDimensionsParam: false,
  },
]

export const DEFAULT_EMBEDDINGS_MODEL = OPENAI_EMBEDDING_MODELS[0].id

export function findEmbeddingModel(id: string): OpenAiEmbeddingModel | undefined {
  return OPENAI_EMBEDDING_MODELS.find((m) => m.id === id)
}
