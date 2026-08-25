import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { mintSyntheticPhone } from '@/lib/contacts/synthetic-phone'
import { sendTelegramMessage } from '@/lib/telegram/send'

// ============================================================
// POST /api/leads/[leadFormKey]/submit
//
// The public, unauthenticated connector behind an external lead-
// capture form (e.g. a "Request a free consultation" form built in
// Lovable on the client's own marketing site). A submission:
//   1. finds-or-creates a Contact by email (native name/email/company
//      columns — same shape the dashboard's Contacts UI already reads);
//   2. stores the form's other fields (service, employee count,
//      message) via the existing custom_fields / contact_custom_values
//      system, auto-provisioning those three field definitions the
//      first time an account receives a lead;
//   3. opens a Deal in the account's oldest pipeline (its first-
//      position stage) so the lead shows up on the pipeline board
//      with no extra setup — silently skipped if the account has no
//      pipeline configured yet;
//   4. best-effort notifies the account owner via Telegram.
//
// `leadFormKey` is the same kind of credential as the widget's
// `widgetKey` (049) — a plaintext, low-privilege public value whose
// only power is this one action, scoped to one account. It is a
// SEPARATE key from `widgetKey` so either channel can be rotated
// independently.
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: CORS_HEADERS })
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

const LEAD_FORM_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_FIELD_LENGTH = 500
const MAX_MESSAGE_LENGTH = 4000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Custom-field definitions auto-provisioned on an account's first
// lead. Keyed by the JSON body field so the submit handler can look
// up "which custom_fields row does `service` map to" without a
// hardcoded id.
const LEAD_FIELD_DEFS: { key: 'company' | 'service' | 'employee_count' | 'message'; fieldName: string }[] = [
  { key: 'service', fieldName: 'Servicio de interés' },
  { key: 'employee_count', fieldName: 'Cantidad de empleados' },
  { key: 'message', fieldName: 'Mensaje' },
]

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ leadFormKey: string }> },
): Promise<NextResponse> {
  const { leadFormKey } = await params
  if (!LEAD_FORM_KEY_RE.test(leadFormKey)) {
    return json({ error: 'Not found' }, 404)
  }

  const ip = getClientIp(request)
  const limit = checkRateLimit(`lead:${leadFormKey}:${ip}`, RATE_LIMITS.leadFormSubmit)
  if (!limit.success) {
    return json(
      { error: 'Rate limit exceeded', retry_after_seconds: Math.ceil((limit.reset - Date.now()) / 1000) },
      429,
    )
  }

  const db = supabaseAdmin()

  const { data: account, error: accountErr } = await db
    .from('accounts')
    .select(
      'id, owner_user_id, lead_form_enabled, telegram_notify_enabled, telegram_bot_token, telegram_chat_id',
    )
    .eq('lead_form_key', leadFormKey)
    .maybeSingle()

  if (accountErr) {
    console.error('[lead submit] account lookup failed:', accountErr)
    return json({ error: 'Internal server error' }, 500)
  }
  if (!account || !account.lead_form_enabled) {
    return json({ error: 'Not found' }, 404)
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const fullName = typeof body.full_name === 'string' ? body.full_name.trim().slice(0, 200) : ''
  const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!fullName) return json({ error: 'full_name is required' }, 400)
  if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
    return json({ error: 'A valid email is required' }, 400)
  }

  const company = typeof body.company === 'string' ? body.company.trim().slice(0, MAX_FIELD_LENGTH) : ''
  const service = typeof body.service === 'string' ? body.service.trim().slice(0, MAX_FIELD_LENGTH) : ''
  const employeeCount =
    typeof body.employee_count === 'string' ? body.employee_count.trim().slice(0, MAX_FIELD_LENGTH) : ''
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE_LENGTH) : ''

  try {
    const contact = await findOrCreateLeadContact(db, account.id, account.owner_user_id, {
      fullName,
      email: emailRaw,
      company,
    })

    await saveLeadCustomFields(db, account.id, account.owner_user_id, contact.id, {
      company,
      service,
      employee_count: employeeCount,
      message,
    })

    const dealId = await createLeadDeal(db, account.id, account.owner_user_id, contact.id, fullName)

    if (account.telegram_notify_enabled && account.telegram_bot_token && account.telegram_chat_id) {
      const summary = buildTelegramSummary({ fullName, email: emailRaw, company, service, employeeCount, message })
      // Best-effort — a Telegram hiccup must never fail the lead
      // capture itself (the contact/deal are already committed).
      sendTelegramMessage({
        botToken: account.telegram_bot_token,
        chatId: account.telegram_chat_id,
        text: summary,
      }).catch((err) => {
        console.error('[lead submit] Telegram notify failed:', err)
      })
    }

    return json({ ok: true, contact_id: contact.id, deal_id: dealId })
  } catch (err) {
    console.error('[lead submit] failed:', err)
    return json({ error: 'Internal server error' }, 500)
  }
}

type AdminDb = ReturnType<typeof supabaseAdmin>

async function findOrCreateLeadContact(
  db: AdminDb,
  accountId: string,
  ownerUserId: string,
  fields: { fullName: string; email: string; company: string },
) {
  const { data: existing } = await db
    .from('contacts')
    .select('id, name')
    .eq('account_id', accountId)
    .ilike('email', fields.email)
    .maybeSingle()
  if (existing) return existing

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone: mintSyntheticPhone(),
      name: fields.fullName,
      email: fields.email,
      company: fields.company || null,
    })
    .select('id, name')
    .single()

  if (error) {
    // Lost a race with a concurrent submission from the same email
    // (double-click, retried request) — re-resolve instead of failing.
    if (isUniqueViolation(error)) {
      const { data: raced } = await db
        .from('contacts')
        .select('id, name')
        .eq('account_id', accountId)
        .ilike('email', fields.email)
        .maybeSingle()
      if (raced) return raced
    }
    throw error
  }
  return created
}

async function saveLeadCustomFields(
  db: AdminDb,
  accountId: string,
  ownerUserId: string,
  contactId: string,
  values: { company: string; service: string; employee_count: string; message: string },
) {
  for (const def of LEAD_FIELD_DEFS) {
    const value = values[def.key]
    if (!value) continue

    const customFieldId = await findOrCreateCustomField(db, accountId, ownerUserId, def.fieldName)
    if (!customFieldId) continue

    await db
      .from('contact_custom_values')
      .upsert(
        { contact_id: contactId, custom_field_id: customFieldId, value },
        { onConflict: 'contact_id,custom_field_id' },
      )
  }
}

async function findOrCreateCustomField(
  db: AdminDb,
  accountId: string,
  ownerUserId: string,
  fieldName: string,
): Promise<string | null> {
  const { data: existing } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', accountId)
    .eq('field_name', fieldName)
    .maybeSingle()
  if (existing) return existing.id

  const { data: created, error } = await db
    .from('custom_fields')
    .insert({ account_id: accountId, user_id: ownerUserId, field_name: fieldName, field_type: 'text' })
    .select('id')
    .single()

  if (error) {
    // Concurrent first-lead race provisioning the same field — re-resolve.
    if (isUniqueViolation(error)) {
      const { data: raced } = await db
        .from('custom_fields')
        .select('id')
        .eq('account_id', accountId)
        .eq('field_name', fieldName)
        .maybeSingle()
      if (raced) return raced.id
    }
    console.error('[lead submit] custom field provisioning failed:', error)
    return null
  }
  return created.id
}

/**
 * Opens a Deal in the account's oldest pipeline, first-position stage
 * — there's no "default pipeline" concept in this codebase, so this
 * is the least-surprising stand-in. Returns null (skipping Deal
 * creation) rather than throwing when the account has no pipeline
 * configured yet, since the Contact + custom fields are still a
 * complete, useful capture on their own.
 */
async function createLeadDeal(
  db: AdminDb,
  accountId: string,
  ownerUserId: string,
  contactId: string,
  contactName: string,
): Promise<string | null> {
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pipeline) return null

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!stage) return null

  const { data: created, error } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: contactId,
      title: `Lead: ${contactName}`,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[lead submit] deal creation failed:', error)
    return null
  }
  return created.id
}

function buildTelegramSummary(fields: {
  fullName: string
  email: string
  company: string
  service: string
  employeeCount: string
  message: string
}): string {
  const lines = [
    `🆕 Nuevo lead: ${fields.fullName}`,
    `Email: ${fields.email}`,
  ]
  if (fields.company) lines.push(`Empresa: ${fields.company}`)
  if (fields.service) lines.push(`Servicio de interés: ${fields.service}`)
  if (fields.employeeCount) lines.push(`Cantidad de empleados: ${fields.employeeCount}`)
  if (fields.message) lines.push(`Mensaje: ${fields.message}`)
  return lines.join('\n')
}
