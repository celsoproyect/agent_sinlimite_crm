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
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini (equilibrado, por defecto)' },
  { id: 'gpt-5.4', label: 'GPT-5.4 (más capaz)' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano (más económico)' },
]

export const OPENAI_EMBEDDING_MODELS: OpenAiEmbeddingModel[] = [
  {
    id: 'text-embedding-3-small',
    label: 'text-embedding-3-small (recomendado)',
    dimensions: 1536,
    supportsDimensionsParam: true,
  },
  {
    id: 'text-embedding-3-large',
    label: 'text-embedding-3-large (mayor calidad, más lento)',
    dimensions: 1536,
    supportsDimensionsParam: true,
  },
  {
    id: 'text-embedding-ada-002',
    label: 'text-embedding-ada-002 (legado)',
    dimensions: 1536,
    supportsDimensionsParam: false,
  },
]

export const DEFAULT_EMBEDDINGS_MODEL = OPENAI_EMBEDDING_MODELS[0].id

export function findEmbeddingModel(id: string): OpenAiEmbeddingModel | undefined {
  return OPENAI_EMBEDDING_MODELS.find((m) => m.id === id)
}
