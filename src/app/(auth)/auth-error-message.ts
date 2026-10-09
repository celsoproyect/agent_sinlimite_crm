// Supabase Auth returns English error messages. The auth pages map the
// stable `code` (or the HTTP status) to a key in the "AuthErrors"
// message namespace so the visitor reads them in their own language.

const CODE_KEY: Record<string, string> = {
  invalid_credentials: "invalidCredentials",
  email_not_confirmed: "emailNotConfirmed",
  user_already_exists: "userExists",
  email_exists: "userExists",
  weak_password: "weakPassword",
  same_password: "samePassword",
  email_address_invalid: "invalidEmail",
  over_email_send_rate_limit: "rateLimited",
  over_request_rate_limit: "rateLimited",
  session_not_found: "sessionExpired",
  session_expired: "sessionExpired",
  signup_disabled: "signupDisabled",
};

export function authErrorMessage(
  error: { code?: string; status?: number; message: string },
  t: (key: string) => string,
): string {
  const key = error.code ? CODE_KEY[error.code] : undefined;
  if (key) return t(key);
  if (error.status === 429) return t("rateLimited");
  if (/invalid login credentials/i.test(error.message)) return t("invalidCredentials");
  return t("generic");
}
