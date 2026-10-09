"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { authErrorMessage } from "../auth-error-message";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, MailX, MessageSquare, CheckCircle, UsersRound } from "lucide-react";

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

interface PeekOk {
  ok: true;
  account_name: string;
}
interface PeekFail {
  ok: false;
  reason: "not_found" | "used" | "expired" | "server_error";
}

// Self-service signup is closed — accounts are only created by an
// existing admin's invite (see /join/<token>). This gate re-validates
// the same `invite` token server-side via the public peek endpoint
// (also used by /join) before rendering the form, rather than just
// hiding the link on /login — the signUp() call below has no auth of
// its own, so a visitor who guessed/bookmarked the raw /signup URL
// could otherwise still self-register.
type Gate =
  | { status: "loading" }
  | { status: "no_invite" }
  | { status: "invalid"; reason: PeekFail["reason"] }
  | { status: "ok"; accountName: string };

// Message keys (AuthPages namespace) for each closed-gate state.
const GATE_COPY: Record<"no_invite" | PeekFail["reason"], { title: string; body: string }> = {
  no_invite: { title: "gateNoInviteTitle", body: "gateNoInviteBody" },
  not_found: { title: "gateNotFoundTitle", body: "gateNotFoundBody" },
  used: { title: "gateUsedTitle", body: "gateUsedBody" },
  expired: { title: "gateExpiredTitle", body: "gateExpiredBody" },
  server_error: { title: "gateErrorTitle", body: "gateErrorBody" },
};

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // points back at /join/<token> so the user lands on the redeem
  // step after verifying instead of being dropped on /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("AuthPages");
  const tErr = useTranslations("AuthErrors");

  const [gate, setGate] = useState<Gate>(
    inviteToken ? { status: "loading" } : { status: "no_invite" },
  );

  useEffect(() => {
    // No token → the initial state already resolved to "no_invite"
    // (see useState above); nothing to fetch.
    if (!inviteToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/invitations/${encodeURIComponent(inviteToken)}/peek`,
          { cache: "no-store" },
        );
        const body = (await res.json()) as PeekOk | PeekFail;
        if (cancelled) return;
        setGate(
          body.ok
            ? { status: "ok", accountName: body.account_name }
            : { status: "invalid", reason: body.reason },
        );
      } catch (err) {
        console.error("[signup] peek error:", err);
        if (cancelled) return;
        setGate({ status: "invalid", reason: "server_error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("passwordsMismatch"));
      return;
    }

    if (password.length < 6) {
      setError(t("passwordMin", { min: 6 }));
      return;
    }

    setLoading(true);

    // If we have an invite token, point Supabase's verification
    // email back at the join page so the user can accept after
    // verifying. Without a token, Supabase uses its default
    // redirect (the app root).
    const emailRedirectTo = inviteToken
      ? `${window.location.origin}/join/${encodeURIComponent(inviteToken)}`
      : undefined;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        ...(emailRedirectTo ? { emailRedirectTo } : {}),
      },
    });

    if (error) {
      setError(authErrorMessage(error, tErr));
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (gate.status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <Card className="w-full max-w-sm border-border bg-card">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t("verifying")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (gate.status === "no_invite" || gate.status === "invalid") {
    const copy =
      gate.status === "no_invite" ? GATE_COPY.no_invite : GATE_COPY[gate.reason];
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <Card className="w-full max-w-sm border-border bg-card">
          <CardHeader className="items-center justify-items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
              <MailX className="h-6 w-6 text-red-400" />
            </div>
            <CardTitle className="text-xl text-foreground">{t(copy.title)}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t(copy.body)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("backToSignIn")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <Card className="w-full max-w-sm border-border bg-card">
          <CardHeader className="items-center justify-items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              {t("checkEmail")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("signupSent", { email })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
            >
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("backToSignIn")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <Card className="w-full max-w-sm border-border bg-card">
        <CardHeader className="items-center justify-items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {inviteToken ? (
              <UsersRound className="h-6 w-6 text-primary" />
            ) : (
              <MessageSquare className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? t("titleJoin") : t("titleCreate")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken ? t("descJoin") : t("descCreate")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                {t("fullName")}
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder={t("fullNamePlaceholder")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t("emailLabel")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t("passwordLabel")}
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={t("atLeast", { min: 6 })}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                {t("confirmPassword")}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder={t("repeatPassword")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t("creating") : t("createAccount")}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t("haveAccount")}{" "}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="text-primary hover:text-primary/80"
            >
              {t("signIn")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
