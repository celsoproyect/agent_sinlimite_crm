import { NextResponse } from 'next/server'
import { GOOGLE_OAUTH_CHANNEL, type GoogleOAuthResult } from './oauth-result'

// The end of the Google Calendar OAuth round trip. A full-page flow goes
// back to /agenda?google=<status>. A popup flow (Agenda → Google Calendar
// → "Conectar" opens one) gets a tiny page that tells the CRM tab the
// outcome, through window.opener and a BroadcastChannel (the opener link
// can be lost after visiting Google), then closes itself. If it can't
// close, because the browser opened it as a normal tab, it falls back to
// the agenda.

export function popupResultHtml(base: string, status: GoogleOAuthResult): string {
  const fallback = `${base}/agenda?google=${status}`
  const message = JSON.stringify({ source: GOOGLE_OAUTH_CHANNEL, status })
  const ok = status === 'connected'
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google Calendar</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f4f4f5; color: #18181b; }
  @media (prefers-color-scheme: dark) { body { background: #09090b; color: #fafafa; } a { color: #a5b4fc; } }
  main { text-align: center; padding: 24px; max-width: 320px; }
  p { margin: 8px 0; font-size: 15px; line-height: 1.4; }
  a { color: #4f46e5; font-size: 14px; }
</style>
</head>
<body>
<main>
  <p>${ok ? 'Google Calendar conectado.' : 'No se pudo conectar Google Calendar.'}</p>
  <p>Esta ventana se cerrará sola.</p>
  <a href="${fallback}">Volver al CRM</a>
</main>
<script>
(function () {
  var msg = ${message};
  try { if (window.opener) window.opener.postMessage(msg, ${JSON.stringify(base)}); } catch (e) {}
  try { var c = new BroadcastChannel(${JSON.stringify(GOOGLE_OAUTH_CHANNEL)}); c.postMessage(msg); c.close(); } catch (e) {}
  setTimeout(function () { window.close(); }, 200);
  setTimeout(function () { location.replace(${JSON.stringify(fallback)}); }, 1500);
})();
</script>
</body>
</html>`
}

/** Ends the OAuth flow the way it started: popup page or redirect. */
export function oauthResult(base: string, status: GoogleOAuthResult, popup: boolean): NextResponse {
  if (!popup) return NextResponse.redirect(`${base}/agenda?google=${status}`)
  return new NextResponse(popupResultHtml(base, status), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
