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
import { formatPropertyRoster, getPropertyDirectory, runPropertySearch, type PropertyDirectory } from '@/lib/real-estate/directory'
import type { VenueTools } from './providers/venue-tools'
import type { ResolvedAttachment } from './types'

/** Most photos one send_property_photos call sends. */
const MAX_PROPERTY_PHOTOS = 5

// ============================================================
// Restaurant/events modules for every AI channel: what the prompt says
// about the floor and the halls, and the tool executors. One place, so
// WhatsApp, the web widget, the inbox draft and the Playground agree.
// ============================================================

export interface Venue {
  restaurant: RestaurantDirectory | null
  events: EventDirectory | null
  /** Real estate module (077): the listings. */
  realEstate: PropertyDirectory | null
}

/** Every directory (each null while its module is off or empty). */
export async function loadVenue(db: SupabaseClient, accountId: string): Promise<Venue> {
  const [restaurant, events, realEstate] = await Promise.all([
    getRestaurantDirectory(db, accountId),
    getEventDirectory(db, accountId),
    getPropertyDirectory(db, accountId),
  ])
  return { restaurant, events, realEstate }
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
  propertyRoster: string | null
} {
  return {
    restaurantRoster: venue.restaurant ? formatRestaurantRoster(venue.restaurant) : null,
    eventRoster: venue.events ? formatEventRoster(venue.events) : null,
    waitlistAvailable: !!venue.restaurant?.waitlist,
    propertyRoster: venue.realEstate ? formatPropertyRoster(venue.realEstate) : null,
  }
}

/**
 * The tool executors. With `write` false (the Playground) nothing is
 * saved: the booking tools answer as if they had. `photoSink` collects
 * the property photos `send_property_photos` picks, which the caller
 * sends before the reply (WhatsApp only; without it the tool isn't
 * offered).
 */
export function venueTools(
  db: SupabaseClient,
  venue: Venue,
  ctx: {
    accountId: string
    contactId: string | null
    conversationId: string | null
    write: boolean
    photoSink?: ResolvedAttachment[]
  },
): VenueTools | undefined {
  const { restaurant, events, realEstate } = venue
  if (!restaurant && !events && !realEstate) return undefined
  const { photoSink } = ctx
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
    ...(realEstate
      ? {
          realEstate: {
            search: async (args) => runPropertySearch(realEstate, args),
            sendPhotos: photoSink
              ? async (propertyId) => {
                  const p = realEstate.properties.find((x) => x.id === propertyId || x.code === propertyId)
                  if (!p) return { sent: 0, error: 'unknown property_id: use one from search_properties' }
                  if (p.photos.length === 0) return { sent: 0, error: 'this property has no photos yet; offer a visit instead' }
                  const photos = p.photos.slice(0, MAX_PROPERTY_PHOTOS)
                  photos.forEach((url, i) => {
                    photoSink.push({
                      name: i === 0 ? p.title : `${p.title} (${i + 1}/${photos.length})`,
                      kind: 'image',
                      mediaUrl: url,
                      filename: url.split('/').pop()?.split('?')[0] || 'foto.jpg',
                      // The first photo carries the price as a product card.
                      ...(i === 0 && p.price != null ? { price: p.price, currency: p.currency, description: p.description ?? undefined } : {}),
                    })
                  })
                  return { sent: photos.length }
                }
              : undefined,
          },
        }
      : {}),
  }
}
