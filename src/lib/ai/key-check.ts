import { validateAiCredentials } from './validate'
import { embedTexts } from './embeddings'
import { DEFAULT_EMBEDDINGS_MODEL } from './models'
import { AiError, type AiProvider } from './types'

// "Verify before save" for the provider keys a super admin enters (the
// platform key and per-account own keys). Each returns an error message
// for the form, or null when the key works.

export async function checkChatKey(
  provider: AiProvider,
  model: string,
  apiKey: string,
): Promise<string | null> {
  try {
    await validateAiCredentials({
      provider,
      model,
      apiKey,
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: false,
      autoReplyMaxPerConversation: 3,
      replyDelaySeconds: 0,
      temperature: 0.7,
      handoffAgentId: null,
      handoffOnMissingInfo: true,
      leadPipelineId: null,
      embeddingsApiKey: null,
      embeddingsModel: DEFAULT_EMBEDDINGS_MODEL,
    })
    return null
  } catch (err) {
    if (err instanceof AiError) return err.message
    console.error('[ai key check] chat key validation error:', err)
    return 'Could not validate the API key with the provider.'
  }
}

export async function checkEmbeddingsKey(
  apiKey: string,
  model: string,
): Promise<string | null> {
  try {
    await embedTexts(apiKey, ['ping'], model)
    return null
  } catch (err) {
    if (err instanceof AiError) return `Embeddings key: ${err.message}`
    console.error('[ai key check] embeddings validation error:', err)
    return 'Could not validate the embeddings key.'
  }
}
