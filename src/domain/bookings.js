import { nowIso } from '../db.js';
import { errors } from '../errors.js';
import { newReference } from './reference.js';

const MAX_REFERENCE_ATTEMPTS = 5;

// Interface policy, not a capacity rule: it keeps one form submission from
// draining an event. The real constraint — seats remaining — is enforced by
// the claim statement regardless of what any caller sends.
export const MAX_SEATS_PER_BOOKING = 10;

/**
 * Capacity is enforced HERE, at the data layer, by independent mechanisms:
 *
 *  1. The atomic conditional UPDATE in book(): its WHERE clause only matches
 *     while enough seats remain, so the check and the claim are one SQL
 *     statement — there is no read-then-write window at any layer.
 *  2. The seats_within_capacity CHECK constraint (schema.sql): even if (1)
 *     were deleted, the database refuses the commit.
 *  3. SQLite itself permits one write transaction at a time — across
 *     processes too, via the database write lock — so concurrent claims
 *     serialize and the loser re-evaluates the WHERE clause against the
 *     committed value. Node's single thread is an incidental fourth layer
 *     that correctness deliberately does not rely on (the multi-process
 *     test proves it).
 *
 * The claim and the booking INSERT share one immediate transaction: a crash
 * between them rolls both back, so no seat can be claimed without a booking
 * and no held/pending state exists to get stuck.
 */
export function createBookings(db, { now = nowIso, generateReference = newReference } = {}) {
  const claimSeats = db.prepare(`
    UPDATE events
       SET seats_booked = seats_booked + :quantity
     WHERE id = :eventId
       AND starts_at > :now
       AND seats_booked + :quantity <= capacity
  `);

  const readEvent = db.prepare('SELECT starts_at, capacity, seats_booked FROM events WHERE id = ?');

  const insertBooking = db.prepare(`
    INSERT INTO bookings (reference, event_id, attendee_name, attendee_email, quantity, created_at)
    VALUES (:reference, :eventId, :name, :email, :quantity, :createdAt)
  `);

  // The status guard makes cancellation race-safe: of any number of
  // concurrent cancels, exactly one flips the row, so the seats are
  // returned exactly once. RETURNING hands back what to return.
  const flipToCancelled = db.prepare(`
    UPDATE bookings
       SET status = 'cancelled', cancelled_at = :now
     WHERE reference = :reference
       AND status = 'confirmed'
    RETURNING event_id, quantity
  `);

  const returnSeats = db.prepare('UPDATE events SET seats_booked = seats_booked - ? WHERE id = ?');

  const referenceExists = db.prepare('SELECT 1 FROM bookings WHERE reference = ?');

  const readBookingView = db.prepare(`
    SELECT b.reference, b.status, b.quantity, b.attendee_name, b.attendee_email,
           b.created_at, b.cancelled_at,
           e.id AS event_id, e.name AS event_name, e.venue AS event_venue,
           e.starts_at AS event_starts_at, e.capacity, e.seats_booked
      FROM bookings b
      JOIN events e ON e.id = b.event_id
     WHERE b.reference = ?
  `);

  const bookTx = db.transaction((eventId, quantity, name, email, at) => {
    const claim = claimSeats.run({ quantity, eventId, now: at });

    if (claim.changes === 0) {
      // The claim already failed atomically; this read is only for picking
      // the honest error, accurate as of this transaction.
      const event = readEvent.get(eventId);
      if (!event) throw errors.eventNotFound();
      if (event.starts_at <= at) throw errors.eventStarted();
      const remaining = event.capacity - event.seats_booked;
      if (remaining === 0) throw errors.soldOut();
      throw errors.notEnoughSeats(remaining, quantity);
    }

    // A UNIQUE collision on the reference must not cost the user their seat.
    // A failed statement only rolls back itself, not the transaction, so the
    // claim above stays valid while we retry with a fresh reference.
    for (let attempt = 1; ; attempt += 1) {
      const reference = generateReference();
      try {
        insertBooking.run({ reference, eventId, name, email, quantity, createdAt: at });
        return reference;
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && attempt < MAX_REFERENCE_ATTEMPTS) continue;
        throw err; // aborts the transaction — the claimed seats are released
      }
    }
  });

  const cancelTx = db.transaction((reference, at) => {
    const flipped = flipToCancelled.get({ reference, now: at });
    if (!flipped) {
      if (!referenceExists.get(reference)) throw errors.bookingNotFound();
      throw errors.alreadyCancelled();
    }
    returnSeats.run(flipped.quantity, flipped.event_id);
  });

  function book({ eventId, quantity, name, email }) {
    if (!Number.isInteger(eventId)) throw errors.eventNotFound();
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw errors.validation('Seat quantity must be a whole number of at least 1.');
    }
    const reference = bookTx.immediate(eventId, quantity, name, email, now());
    return getByReference(reference);
  }

  function cancel(reference) {
    cancelTx.immediate(reference, now());
    return getByReference(reference);
  }

  function getByReference(reference) {
    const row = readBookingView.get(reference);
    return row ? toBookingView(row) : null;
  }

  return { book, cancel, getByReference };
}

function toBookingView(row) {
  return {
    reference: row.reference,
    status: row.status,
    quantity: row.quantity,
    attendeeName: row.attendee_name,
    attendeeEmail: row.attendee_email,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    event: {
      id: row.event_id,
      name: row.event_name,
      venue: row.event_venue,
      startsAt: row.event_starts_at,
      seatsRemaining: row.capacity - row.seats_booked,
    },
  };
}
