import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { DEFAULT_WIDGET_CONFIG, normalizeWidgetConfig } from '@/lib/widget/config'

// ============================================================
// GET /api/widget/[widgetKey]/config
//
// Public: what /widget.js fetches on load to draw itself — agent name,
// images, welcome text, quick questions, colors (accounts.widget_config,
// migration 060). Everything returned here is meant for the client's
// website visitors, so it's safe to expose under the public widget key.
// A disabled widget answers 404 and the script renders nothing.
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const WIDGET_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ widgetKey: string }> },
): Promise<NextResponse> {
  const { widgetKey } = await params
  if (!WIDGET_KEY_RE.test(widgetKey)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS })
  }

  const db = supabaseAdmin()
  let { data: account, error } = await db
    .from('accounts')
    .select('widget_enabled, widget_config')
    .eq('widget_key', widgetKey)
    .maybeSingle()

  // Migration 060 not applied yet → serve the defaults instead of
  // breaking every embedded widget.
  if (error?.code === '42703') {
    ;({ data: account, error } = await db
      .from('accounts')
      .select('widget_enabled')
      .eq('widget_key', widgetKey)
      .maybeSingle())
  }

  if (error) {
    console.error('[widget config] lookup failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: CORS_HEADERS })
  }
  if (!account || !account.widget_enabled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS })
  }

  const config =
    'widget_config' in account ? normalizeWidgetConfig(account.widget_config) : DEFAULT_WIDGET_CONFIG

  return NextResponse.json(config, {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60' },
  })
}
