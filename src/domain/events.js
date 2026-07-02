import { nowIso } from '../db.js';

export function createEvents(db, { now = nowIso } = {}) {
  const selectUpcoming = db.prepare(`
    SELECT id, name, venue, starts_at, capacity, seats_booked
      FROM events
     WHERE starts_at > ?
     ORDER BY starts_at ASC
  `);

  const selectById = db.prepare(
    'SELECT id, name, venue, starts_at, capacity, seats_booked FROM events WHERE id = ?',
  );

  function listUpcoming() {
    const at = now();
    return selectUpcoming.all(at).map((row) => toEventView(row, at));
  }

  function getById(id) {
    // A malformed id cannot name any event; it reads as "not found".
    if (!Number.isInteger(id)) return null;
    const row = selectById.get(id);
    return row ? toEventView(row, now()) : null;
  }

  return { listUpcoming, getById };
}

// seatsRemaining is always derived, never stored — one source of truth.
function toEventView(row, at) {
  return {
    id: row.id,
    name: row.name,
    venue: row.venue,
    startsAt: row.starts_at,
    capacity: row.capacity,
    seatsRemaining: row.capacity - row.seats_booked,
    soldOut: row.seats_booked >= row.capacity,
    started: row.starts_at <= at,
  };
}
