// ============================================================
// Example data (migration 068: `is_sample` on doctors, services, tables,
// halls, packages, bookings, contacts and reminder rules).
//
// Examples stand in only until the business adds its own: as soon as one
// real row of a kind exists, the AI ignores the example rows of that kind,
// so a customer is never seated at an example table or booked with an
// example doctor next to the real ones. "Quitar ejemplos" removes them.
// ============================================================

export function preferReal<T extends { is_sample?: boolean | null }>(rows: T[]): T[] {
  return rows.some((r) => !r.is_sample) ? rows.filter((r) => !r.is_sample) : rows
}
