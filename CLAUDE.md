@AGENTS.md

# Project notes (Sin Limite IA CRM)

- **Language:** the owner works in Spanish. The UI is translated with next-intl (`messages/en.json`, `es.json`, `ko.json`); every new string goes into all three. Spanish labels run longer than English ones, so never rely on `whitespace-nowrap` inside fixed-width columns (the settings rail used to spill over its panel).
- **Timezone:** the business always runs in `America/Santo_Domingo`. Use the helpers in `src/lib/business-timezone.ts` (`businessToday`, `businessDate`, `businessTime`, `businessLocalToInstant`, …), never the host's or browser's local time. Tests run with `TZ=UTC`.
- **Verifying Supabase writes:** an update that RLS filters out returns no error and 0 rows. When a save must have happened, chain `.select()` and check the rows.
- **AI agent** (`src/lib/ai/`):
  - Channels: WhatsApp goes through `auto-reply.ts`, the web widget through `widget-reply.ts` (text only, no booking), and the inbox draft and the playground through `src/app/api/ai/*`. Both providers (`providers/openai.ts`, `providers/anthropic.ts`) declare the same tools, and the shared parsing lives in `providers/shared.ts`. A tool change has to touch both adapters.
  - Booking tools are only wired when `accounts.booking_settings.hours` is saved. Without them, the prompt forbids promising appointments.
  - `check_availability(date, time?)` returns `{ requested, slots }`. When the requested time is free, the agent books it right away; otherwise it offers the 3 nearest open slots, which can fall on other days.
  - Every booking needs the customer's full name and phone (`customer_name`/`customer_phone`, migration 062). The reference code is `CITA-` plus the first 6 hex digits of the booking id (`src/lib/bookings/reference.ts`), so it needs no column. WhatsApp BSUID contacts have no phone, which is why the agent asks for one.
  - Changes go through `find_appointments` (by phone, optionally the reference) → `check_availability` → `reschedule_appointment`, which moves the same row and resets its reminder sends. `cancel_appointment` cancels. The agent must never call `book_appointment` to change an appointment.
  - Capture tools: `set_customer_name`, `add_note`, `set_custom_field` (only offered when the account has custom fields defined), `set_lead_stage` (only when `ai_configs.lead_pipeline_id` is set; it also carries the deal `value`/`currency`, persisted by `applyLeadCapture` in `custom-fields.ts`) and `set_sentiment`.
- **Booking reminders:** rules live in `booking_reminder_rules` (Agenda → Recordatorios; `{{reference}}` is available). The server drains due reminders every minute on its own (`startBookingReminderScheduler` in `src/lib/bookings/drain-reminders.ts`, started from `src/instrumentation.ts` in production only, since dev shares the production DB). `BOOKING_REMINDERS_INTERVAL` (seconds, `off` to disable) tunes it. `/api/bookings/reminders/cron` drains them on demand.
- **Agenda UI:** stat cards (`booking-stats.tsx`) and a filterable list view (`booking-list.tsx`) sit beside the week view. Date ranges come from `src/lib/bookings/ranges.ts` (business-local days). The dashboard shows `upcoming-bookings.tsx` when the agenda module is on.
- **Favicon:** `platform_settings.favicon_url` (migration 062), uploaded in Super admin → Branding. `src/app/icon.tsx` renders it, falling back to `logo_url`. It accepts PNG, JPG or SVG only, because satori can't decode WebP.
- **WhatsApp:** the Cloud API never provides customer profile photos, so `contacts.avatar_url` is only filled by hand. Inbound webhooks depend on the Meta app's callback URL pointing at this deployment, plus a valid `META_APP_SECRET`.
  - Read receipts and the typing indicator go through `engineMarkRead` (`src/lib/flows/meta-send.ts`). The auto-reply calls it before generating. The inbox calls `/api/whatsapp/read` when an agent opens a thread with unread messages, and while the agent types (throttled to once every 20s).
  - Meta gives no "customer is typing" event, so the inbox can't show one.
- **Web widget** (`public/widget.js`, plain ES5 with no build step):
  - Spanish only. Its look comes from `accounts.widget_config` (migration 060), normalized by `src/lib/widget/config.ts`, served by `GET /api/widget/[key]/config` and edited in Canales → Widget web → Apariencia.
  - Preview page: `/widget-preview.html?key=…`.
  - The visitor is asked their name after the first message, and the transcript is kept in localStorage.
- **Branding and color mode:**
  - Mode lives in `html[data-mode]` (light/dark; no attribute means dark), set by the boot script in `layout.tsx` and `use-theme.tsx`. Tailwind's `dark:` variant targets a `.dark` class that is never set, so those classes never apply; style per mode through the tokens in `globals.css`.
  - Light mode is a gray canvas (`--background`) with white cards and a soft card shadow, so surfaces don't blend into the page.
  - `platform_settings.logo_url` is the dark-mode logo, also used for the favicon. `logo_light_url` (migration 061, nullable) is the light-mode logo. Render logos with `BrandLogo` (`src/components/layout/brand-logo.tsx`): it outputs both images and CSS hides the wrong one, so there's no flash. Uploads happen in /super-admin → Marca.
- **Migrations:** the Supabase CLI here lacks privileges (`db push` fails with 403). New `supabase/migrations/*.sql` must be pasted into the Supabase SQL Editor by the owner, and code should tolerate the column being missing (`42703`) until then.
- **Inbox:** the colored dot on each conversation row is its status (open, pending or closed). It is not an unread marker, and the owner wants it kept that way. Unread is shown by the numeric badge.
- **Checks before committing:** `npx tsc --noEmit -p .`, `npx eslint src`, `npx vitest run`.
- **Deploy:** Dokploy builds from `main`. Commit only when asked.
