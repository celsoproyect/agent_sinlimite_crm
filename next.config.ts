import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Baseline security headers applied to every response.
 *
 * CSP ships as `Content-Security-Policy-Report-Only` so the browser
 * surfaces violations in the console without blocking anything — once
 * we have confidence nothing legit trips it (two deploys, a pass on
 * every route), flip the key to `Content-Security-Policy` to enforce.
 *
 * The rest of the headers are straight blocks, safe to enforce today:
 *   - HSTS: only meaningful on HTTPS (no-op on http://localhost).
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy:
 *     baseline OWASP hardening, no behavioural cost.
 *   - Permissions-Policy: we don't use camera / microphone / etc, so
 *     deny them. A supply-chain compromise or a forgotten plugin
 *     can't silently opt back in.
 */
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Microphone is allowed for same-origin (`self`) so the inbox
    // composer can record voice notes via MediaRecorder. Everything
    // else stays denied — a compromised dependency can't silently grab
    // the camera / geolocation / etc.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      // Next.js needs 'unsafe-inline' for its inline hydration script
      // and 'unsafe-eval' in dev + some production optimisations.
      // Nonce-based CSP is a later project.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind + inline style attributes on lots of components.
      "style-src 'self' 'unsafe-inline'",
      // Supabase public-bucket avatars, contact avatars (arbitrary
      // https URLs paste-able from the UI), OG images, data URLs for
      // tiny inline assets.
      "img-src 'self' data: blob: https:",
      // Outbound media previews (blob: from MediaRecorder + file picker)
      // and Supabase public-bucket audio/video the inbox renders.
      "media-src 'self' blob: https://*.supabase.co",
      "font-src 'self' data:",
      // Supabase REST + realtime (WSS). All Meta API calls happen
      // server-side, so graph.facebook.com does not belong here.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
] as const;

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) so the
  // Docker image can run without node_modules or the Next CLI.
  // Harmless outside Docker: `next start` keeps working as before.
  output: "standalone",

  /**
   * The KB file-upload route's parsers (pdf-parse, mammoth, exceljs,
   * csv-parse) use conditional `exports` maps / dynamic requires that
   * Next's build-time file tracer (@vercel/nft) fails to resolve as
   * dependencies of the route. Left alone, `.next/standalone` ships
   * without them, so the route's top-level `import` throws "Cannot
   * find module" at request time in prod (works fine in `next dev`,
   * which uses the full node_modules — this only breaks in Docker).
   *
   * Naming just the four top-level packages (the original fix) is not
   * enough: the tracer never even walks their `require()` calls, so
   * their own hoisted transitive dependencies (pdfjs-dist for
   * pdf-parse; jszip, @xmldom/xmldom, etc. for mammoth; archiver,
   * unzipper, etc. for exceljs) are missing too, and the module still
   * crashes as soon as a parser is actually invoked. This list is the
   * full transitive dependency closure (computed by walking each
   * package's package.json `dependencies` recursively against the
   * installed node_modules tree) — regenerate it the same way if any
   * of these four packages' dependencies ever change.
   *
   * `@napi-rs/canvas` (an optional native binding pdf-parse only uses
   * for image rendering, not text extraction) is deliberately left
   * out: pdf-parse wraps that require in try/catch and degrades
   * gracefully when it's absent.
   */
  outputFileTracingIncludes: {
    "/api/ai/knowledge/upload": [
      "./node_modules/@fast-csv/format/**/*",
      "./node_modules/@fast-csv/parse/**/*",
      "./node_modules/@xmldom/xmldom/**/*",
      "./node_modules/archiver/**/*",
      "./node_modules/async/**/*",
      "./node_modules/balanced-match/**/*",
      "./node_modules/base64-js/**/*",
      "./node_modules/big-integer/**/*",
      "./node_modules/binary/**/*",
      "./node_modules/bl/**/*",
      "./node_modules/bluebird/**/*",
      "./node_modules/buffer/**/*",
      "./node_modules/buffer-crc32/**/*",
      "./node_modules/buffer-indexof-polyfill/**/*",
      "./node_modules/buffers/**/*",
      "./node_modules/chainsaw/**/*",
      "./node_modules/compress-commons/**/*",
      "./node_modules/concat-map/**/*",
      "./node_modules/core-util-is/**/*",
      "./node_modules/crc-32/**/*",
      "./node_modules/crc32-stream/**/*",
      "./node_modules/csv-parse/**/*",
      "./node_modules/dayjs/**/*",
      "./node_modules/dingbat-to-unicode/**/*",
      "./node_modules/duck/**/*",
      "./node_modules/duplexer2/**/*",
      "./node_modules/end-of-stream/**/*",
      "./node_modules/exceljs/**/*",
      "./node_modules/fast-csv/**/*",
      "./node_modules/fs-constants/**/*",
      "./node_modules/fs.realpath/**/*",
      "./node_modules/fstream/**/*",
      "./node_modules/glob/**/*",
      "./node_modules/graceful-fs/**/*",
      "./node_modules/ieee754/**/*",
      "./node_modules/immediate/**/*",
      "./node_modules/inflight/**/*",
      "./node_modules/inherits/**/*",
      "./node_modules/jszip/**/*",
      "./node_modules/lazystream/**/*",
      "./node_modules/lie/**/*",
      "./node_modules/listenercount/**/*",
      "./node_modules/lodash.defaults/**/*",
      "./node_modules/lodash.difference/**/*",
      "./node_modules/lodash.escaperegexp/**/*",
      "./node_modules/lodash.flatten/**/*",
      "./node_modules/lodash.groupby/**/*",
      "./node_modules/lodash.isboolean/**/*",
      "./node_modules/lodash.isequal/**/*",
      "./node_modules/lodash.isfunction/**/*",
      "./node_modules/lodash.isnil/**/*",
      "./node_modules/lodash.isplainobject/**/*",
      "./node_modules/lodash.isundefined/**/*",
      "./node_modules/lodash.union/**/*",
      "./node_modules/lodash.uniq/**/*",
      "./node_modules/lop/**/*",
      "./node_modules/mammoth/**/*",
      "./node_modules/minimist/**/*",
      "./node_modules/mkdirp/**/*",
      "./node_modules/normalize-path/**/*",
      "./node_modules/once/**/*",
      "./node_modules/option/**/*",
      "./node_modules/pako/**/*",
      "./node_modules/path-is-absolute/**/*",
      "./node_modules/pdf-parse/**/*",
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/process-nextick-args/**/*",
      "./node_modules/readable-stream/**/*",
      "./node_modules/readdir-glob/**/*",
      "./node_modules/rimraf/**/*",
      "./node_modules/safe-buffer/**/*",
      "./node_modules/saxes/**/*",
      "./node_modules/setimmediate/**/*",
      "./node_modules/sprintf-js/**/*",
      "./node_modules/string_decoder/**/*",
      "./node_modules/tar-stream/**/*",
      "./node_modules/tmp/**/*",
      "./node_modules/traverse/**/*",
      "./node_modules/underscore/**/*",
      "./node_modules/unzipper/**/*",
      "./node_modules/util-deprecate/**/*",
      "./node_modules/uuid/**/*",
      "./node_modules/wrappy/**/*",
      "./node_modules/xmlbuilder/**/*",
      "./node_modules/xmlchars/**/*",
      "./node_modules/zip-stream/**/*",
    ],
  },

  /**
   * Cross-origin dev access (Next.js 16).
   *
   * Next 16 blocks requests to dev-only resources (`/_next/*` internals,
   * the HMR websocket, the dev overlay) unless the browser's Origin is
   * the host the dev server booted on — `localhost` by default. Tunnels
   * like ngrok serve the app from a public HTTPS host, so without
   * allow-listing that host those dev requests come back 403: HMR stops
   * working and the dev session degrades over the tunnel (issue #365).
   *
   * Wildcards match subdomains only (Next's CSRF matcher), so the
   * randomised tunnel subdomain is covered. Add any other host via
   * `ALLOWED_DEV_ORIGINS` (comma-separated). This key is dev-only and
   * has no effect on a production build.
   */
  allowedDevOrigins: [
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.ngrok.io",
    "*.trycloudflare.com",
    "*.loca.lt",
    ...(process.env.ALLOWED_DEV_ORIGINS
      ? process.env.ALLOWED_DEV_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  ],

  /**
   * Cache-Control policy.
   *
   * Why this exists:
   *   Hostinger's CDN was applying `s-maxage=31536000` (1 year) to
   *   prerendered HTML pages by default. When a new deploy shipped
   *   fresh Turbopack chunk hashes, the edge kept serving year-old
   *   HTML referencing chunk filenames that no longer existed on
   *   disk — result: HTML 200, every /_next/static/*.js and .css
   *   came back 404, the page rendered unstyled. Private/incognito
   *   did nothing because the cache is server-side.
   *
   * Strategy:
   *   - /_next/static/* — leave to Next. Turbopack dev chunks can go
   *     stale if we force immutable caching here; Next already emits
   *     the correct production headers for hashed assets.
   *   - /api/*          — no-store. API responses are per-user and
   *     must never be shared across requests at the edge.
   *   - Everything else — public, brief s-maxage + generous
   *     stale-while-revalidate. The edge serves instantly from cache
   *     for the first 5 min, then returns cached content while
   *     refreshing in the background for up to 24 h. A deploy's
   *     chunk-hash drift self-heals within ~5 min with no user-
   *     visible latency.
   *
   *   Note: dynamic dashboard routes (/inbox, /contacts, /pipelines,
   *   /broadcasts, etc.) are server-rendered per request — Next.js
   *   and Supabase auth already prevent them from being served
   *   from a shared cache. The s-maxage here is a ceiling; Next.js
   *   and auth middleware still set `private` / `no-store` for
   *   per-user responses.
   *
   * Security headers are appended via a separate catch-all rule
   * below — Next.js merges headers from every matching rule, so
   * they apply to every response regardless of which cache rule
   * matched.
   */
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        source: "/:path((?!_next/static|_next/image|api).*)",
        headers: [
          {
            key: "Cache-Control",
            value:
              "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
          },
        ],
      },
      {
        // Security headers on every response, including /_next/static
        // assets (nosniff matters there) and /api/* (HSTS + referrer-
        // policy don't hurt).
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
