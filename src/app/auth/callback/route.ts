import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Receives the redirect from Supabase's PKCE email links (password
// recovery, invite, etc.). Exchanges the `code` for a session cookie
// server-side, then forwards to `next` (defaulting to /dashboard).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(
    `${origin}/login?error=auth_callback_failed`,
  );
}
