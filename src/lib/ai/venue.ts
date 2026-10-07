import type { SupabaseClient } from '@supabase/supabase-js'
import {
  checkTableAvailability,
  confirmTableReservation,
  formatRestaurantRoster,
  getRestaurantDirectory,
  joinWaitlist,
  type RestaurantDirectory,
} from '@/lib/restaurant/engine'
import {
  checkHallAvailability,
  eventStatusNote,
  formatEventRoster,
  getEventDirectory,
  requestEvent,
  type EventDirectory,
} from '@/lib/events/engine'
import { accountModuleEnabled } from '@/lib/modules-server'
import type { VenueTools } from './providers/venue-tools'

// ============================================================
// Restaurant/events modules for every AI channel: what the prompt says
// about the floor and the halls, and the tool executors. One place, so
// WhatsApp, the web widget, the inbox draft and the Playground agree.
// ============================================================

export interface Venue {
  restaurant: RestaurantDirectory | null
  events: EventDirectory | null
}

/** Both directories (each null while its module is off or empty). */
export async function loadVenue(db: SupabaseClient, accountId: string): Promise<Venue> {
  const [restaurant, events] = await Promise.all([getRestaurantDirectory(db, accountId), getEventDirectory(db, accountId)])
  return { restaurant, events }
}

/** Whether the agenda's own appointment tools may be offered: business
 *  hours saved (checked by the caller) and the agenda module on. A
 *  restaurant that only takes tables can switch the agenda off. */
export async function agendaModuleOn(db: SupabaseClient, accountId: string): Promise<boolean> {
  return accountModuleEnabled(db, accountId, 'agenda')
}

/** Prompt options for `buildSystemPrompt`. */
export function venuePromptOptions(venue: Venue): {
  restaurantRoster: string | null
  eventRoster: string | null
  waitlistAvailable: boolean
} {
  return {
    restaurantRoster: venue.restaurant ? formatRestaurantRoster(venue.restaurant) : null,
    eventRoster: venue.events ? formatEventRoster(venue.events) : null,
    waitlistAvailable: !!venue.restaurant?.waitlist,
  }
}

/**
 * The tool executors. With `write` false (the Playground) nothing is
 * saved: the booking tools answer as if they had.
 */
export function venueTools(
  db: SupabaseClient,
  venue: Venue,
  ctx: { accountId: string; contactId: string | null; conversationId: string | null; write: boolean },
): VenueTools | undefined {
  const { restaurant, events } = venue
  if (!restaurant && !events) return undefined
  const { accountId, contactId, conversationId, write } = ctx
  const canWrite = write && !!contactId
  return {
    ...(restaurant
      ? {
          restaurant: {
            check: (args) => checkTableAvailability(db, accountId, restaurant, args),
            book: canWrite
              ? (input) => confirmTableReservation(db, { accountId, contactId: contactId!, conversationId, dir: restaurant, input })
              : undefined,
            waitlist:
              canWrite && restaurant.waitlist
                ? (input) => joinWaitlist(db, { accountId, contactId, conversationId, input })
                : undefined,
            waitlistEnabled: restaurant.waitlist,
            allowPreorder: restaurant.settings.allow_preorder,
            allowCombine: restaurant.settings.allow_combine,
            areas: restaurant.areas.map((a) => a.name),
          },
        }
      : {}),
    ...(events
      ? {
          events: {
            check: (args) => checkHallAvailability(db, accountId, events, args),
            request: canWrite
              ? async (input) => {
                  const out = await requestEvent(db, { accountId, contactId: contactId!, conversationId, dir: events, input })
                  return out.status ? { ...out, note: eventStatusNote(out.status) } : out
                }
              : undefined,
            eventTypes: events.settings.event_types,
          },
        }
      : {}),
  }
}
