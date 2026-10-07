// Shared by the OAuth routes and the Agenda dialog (client-safe, no server imports).

/** BroadcastChannel name and message `source` for the popup flow. */
export const GOOGLE_OAUTH_CHANNEL = 'wacrm-google-calendar'

export const GOOGLE_OAUTH_RESULTS = ['connected', 'error', 'denied', 'forbidden', 'migration', 'not_configured'] as const
export type GoogleOAuthResult = (typeof GOOGLE_OAUTH_RESULTS)[number]
