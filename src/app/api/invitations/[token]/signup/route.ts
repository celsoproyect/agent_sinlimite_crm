// ============================================================
// POST /api/invitations/[token]/signup — create the invitee's login.
//
// Signup is invite-only, and the invite link itself (shared privately
// by an admin) is the proof we need, so the user is created already
// confirmed. That skips Supabase's confirmation email, which the
// project's default mailer only delivers to the Supabase team's own
// addresses (and at 2/hour), so invitees never received it.
//
// The client then signs in with the same password and lands on
// /join/<token> to accept.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(`inviteSignup:${clientIp(request)}`, RATE_LIMITS.invitationRedeem);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; password?: unknown; full_name?: unknown }
    | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const fullName = typeof body?.full_name === "string" ? body.full_name.trim().slice(0, 120) : "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data: invite, error: inviteError } = await admin
    .from("account_invitations")
    .select("id")
    .eq("token_hash", hashInviteToken(token ?? ""))
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (inviteError) {
    console.error("[invite signup] lookup error:", inviteError);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  if (!invite) {
    return NextResponse.json({ error: "invite_invalid" }, { status: 404 });
  }

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) {
    const exists = error.code === "email_exists" || /already/i.test(error.message);
    if (!exists) console.error("[invite signup] createUser error:", error);
    return NextResponse.json(
      { error: exists ? "email_exists" : "server_error" },
      { status: exists ? 409 : 500 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
