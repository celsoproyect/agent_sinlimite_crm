import { NextResponse, after } from 'next/server'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { processInstagramWebhook } from '@/lib/instagram/inbound'
import type { InstagramWebhookBody } from '@/lib/instagram/webhook'

// Instagram webhooks (module `instagram`, migration 078). Configured in
// the Meta app under Instagram → API setup with Instagram login →
// Webhooks: callback <base>/api/instagram/webhook, verify token
// INSTAGRAM_WEBHOOK_VERIFY_TOKEN.
export const maxDuration = 60

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const expected = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
  if (
    searchParams.get('hub.mode') === 'subscribe' &&
    expected &&
    searchParams.get('hub.verify_token') === expected &&
    searchParams.get('hub.challenge')
  ) {
    return new Response(searchParams.get('hub.challenge'), { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
}

export async function POST(request: Request) {
  // Raw bytes: the signature covers exactly what Meta sent.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  // Instagram-login webhooks are signed with the Instagram app secret;
  // the Meta app secret is accepted too for apps that route them there.
  const secrets = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter((s): s is string => !!s)
  const valid = secrets.some((secret) => verifyMetaWebhookSignature(rawBody, signature, secret))
  if (!valid) {
    console.warn('[instagram] rejected webhook with an invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: InstagramWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack fast (Meta retries slow acks) and keep working in after().
  after(async () => {
    try {
      await processInstagramWebhook(body)
    } catch (err) {
      console.error('[instagram] processing the webhook failed:', err)
    }
  })
  return NextResponse.json({ status: 'received' })
}
