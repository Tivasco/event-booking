import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestDb, insertEvent, readIntegrity, assertIntegrity } from './helpers.js';
import { createBookings } from '../src/domain/bookings.js';
import { createEvents } from '../src/domain/events.js';

let db;
let bookings;
beforeEach(() => {
  db = makeTestDb();
  bookings = createBookings(db);
});

const attendee = { name: 'Ada Lovelace', email: 'ada@example.com' };

describe('booking', () => {
  test('books a seat and reports it honestly', () => {
    const eventId = insertEvent(db, { capacity: 5 });
    const booking = bookings.book({ eventId, quantity: 1, ...attendee });

    assert.equal(booking.status, 'confirmed');
    assert.match(booking.reference, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    assert.equal(booking.event.seatsRemaining, 4);
    assertIntegrity(assert, db, eventId);
  });

  test('books several seats at once (R3: one or more)', () => {
    const eventId = insertEvent(db, { capacity: 5 });
    const booking = bookings.book({ eventId, quantity: 3, ...attendee });

    assert.equal(booking.quantity, 3);
    assert.equal(booking.event.seatsRemaining, 2);
    assertIntegrity(assert, db, eventId);
  });

  test('refuses a quantity larger than what remains, naming the honest number', () => {
    const eventId = insertEvent(db, { capacity: 5, booked: 3 });
    assert.throws(() => bookings.book({ eventId, quantity: 3, ...attendee }), {
      code: 'NOT_ENOUGH_SEATS',
      message: /Only 2 seats are left — you asked for 3/,
    });
    assert.equal(readIntegrity(db, eventId).seats_booked, 3, 'a failed claim must not consume seats');
  });

  test('refuses a sold-out event', () => {
    const eventId = insertEvent(db, { capacity: 2, booked: 2 });
    assert.throws(() => bookings.book({ eventId, quantity: 1, ...attendee }), { code: 'SOLD_OUT' });
  });

  test('refuses an event that already started', () => {
    const eventId = insertEvent(db, { capacity: 5, startsInDays: -1 });
    assert.throws(() => bookings.book({ eventId, quantity: 1, ...attendee }), { code: 'EVENT_STARTED' });
  });

  test('refuses an event that does not exist — including malformed ids', () => {
    assert.throws(() => bookings.book({ eventId: 999, quantity: 1, ...attendee }), { code: 'EVENT_NOT_FOUND' });
    assert.throws(() => bookings.book({ eventId: 1.5, quantity: 1, ...attendee }), { code: 'EVENT_NOT_FOUND' });
  });

  test('refuses nonsense quantities before touching the database', () => {
    const eventId = insertEvent(db, { capacity: 5 });
    for (const quantity of [0, -1, 1.5, NaN, '2']) {
      assert.throws(() => bookings.book({ eventId, quantity, ...attendee }), { code: 'VALIDATION' });
    }
    assert.equal(readIntegrity(db, eventId).seats_booked, 0);
  });
});

describe('reference collisions', () => {
  test('a colliding reference is retried without losing the claimed seat', () => {
    const eventId = insertEvent(db, { capacity: 2, booked: 1 });
    const takenRef = db.prepare('SELECT reference FROM bookings').get().reference;

    const refs = [takenRef, 'FRESH123'];
    const colliding = createBookings(db, { generateReference: () => refs.shift() });

    const booking = colliding.book({ eventId, quantity: 1, ...attendee });
    assert.equal(booking.reference, 'FRESH123');
    assertIntegrity(assert, db, eventId);
  });

  test('exhausting reference retries rolls the whole booking back — no leaked claim', () => {
    const eventId = insertEvent(db, { capacity: 5, booked: 1 });
    const takenRef = db.prepare('SELECT reference FROM bookings').get().reference;

    const alwaysColliding = createBookings(db, { generateReference: () => takenRef });

    assert.throws(() => alwaysColliding.book({ eventId, quantity: 2, ...attendee }), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    assert.equal(readIntegrity(db, eventId).seats_booked, 1, 'the rolled-back transaction must release the claim');
    assertIntegrity(assert, db, eventId);
  });
});

describe('cancelling', () => {
  test('returns the seats to the pool', () => {
    const eventId = insertEvent(db, { capacity: 5 });
    const booking = bookings.book({ eventId, quantity: 3, ...attendee });

    const cancelled = bookings.cancel(booking.reference);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.cancelledAt);
    assert.equal(cancelled.event.seatsRemaining, 5);
    assertIntegrity(assert, db, eventId);
  });

  test('a freed seat can be booked again', () => {
    const eventId = insertEvent(db, { capacity: 1 });
    const first = bookings.book({ eventId, quantity: 1, ...attendee });
    assert.throws(() => bookings.book({ eventId, quantity: 1, name: 'Grace', email: 'grace@example.com' }), {
      code: 'SOLD_OUT',
    });

    bookings.cancel(first.reference);
    const second = bookings.book({ eventId, quantity: 1, name: 'Grace', email: 'grace@example.com' });
    assert.equal(second.status, 'confirmed');
    assertIntegrity(assert, db, eventId);
  });

  test('cancelling twice returns the seats exactly once', () => {
    const eventId = insertEvent(db, { capacity: 5 });
    const booking = bookings.book({ eventId, quantity: 2, ...attendee });

    bookings.cancel(booking.reference);
    assert.throws(() => bookings.cancel(booking.reference), { code: 'ALREADY_CANCELLED' });
    assert.equal(readIntegrity(db, eventId).seats_booked, 0);
  });

  test('an unknown reference is honestly not found', () => {
    assert.throws(() => bookings.cancel('NOPE1234'), { code: 'BOOKING_NOT_FOUND' });
  });
});

describe('events', () => {
  test('lists only upcoming events, soonest first, with derived availability', () => {
    insertEvent(db, { name: 'Past', startsInDays: -2, capacity: 10 });
    insertEvent(db, { name: 'Later', startsInDays: 9, capacity: 10, booked: 4 });
    insertEvent(db, { name: 'Sooner', startsInDays: 2, capacity: 3, booked: 3 });

    const events = createEvents(db).listUpcoming();
    assert.deepEqual(
      events.map((e) => e.name),
      ['Sooner', 'Later'],
    );
    assert.equal(events[0].soldOut, true);
    assert.equal(events[1].seatsRemaining, 6);
  });

  test('getById reads as not-found for unknown and malformed ids', () => {
    const events = createEvents(db);
    assert.equal(events.getById(999), null);
    assert.equal(events.getById(NaN), null);
    assert.equal(events.getById('abc'), null);
  });
});
