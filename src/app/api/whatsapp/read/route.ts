import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { engineMarkRead } from '@/lib/flows/meta-send';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/read
 *
 * Body: { conversation_id: <uuid>, typing?: boolean }
 *
 * Tells WhatsApp the customer's latest message was read (blue ticks on
 * their phone) when an agent opens the thread in the inbox, and — with
 * `typing: true` — shows them "typing…" while the agent writes a reply.
 * Best-effort: always answers 204 for a conversation the caller can see.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`wa-read:${userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = (await request.json().catch(() => ({}))) as {
      conversation_id?: unknown;
      typing?: unknown;
    };
    if (typeof body.conversation_id !== 'string') {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      );
    }

    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, channel')
      .eq('id', body.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    if (conversation.channel === 'whatsapp') {
      await engineMarkRead(supabase, {
        accountId,
        conversationId: conversation.id,
        typing: body.typing === true,
      });
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
