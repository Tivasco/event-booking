import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestDb, insertEvent } from './helpers.js';
import { nowIso } from '../src/db.js';

// The schema is the last line of defense: these tests prove the database
// refuses to overbook even when application code addresses it with raw SQL,
// i.e. with every application-level guard bypassed.

let db;
beforeEach(() => {
  db = makeTestDb();
});

describe('seats_within_capacity backstop', () => {
  test('rejects pushing seats_booked past capacity with a raw unconditional UPDATE', () => {
    const eventId = insertEvent(db, { capacity: 2, booked: 2 });
    assert.throws(
      () => db.prepare('UPDATE events SET seats_booked = seats_booked + 1 WHERE id = ?').run(eventId),
      { code: 'SQLITE_CONSTRAINT_CHECK', message: /seats_within_capacity/ },
    );
  });

  test('rejects a negative seat count (cancel-side backstop)', () => {
    const eventId = insertEvent(db, { capacity: 5, booked: 0 });
    assert.throws(
      () => db.prepare('UPDATE events SET seats_booked = seats_booked - 1 WHERE id = ?').run(eventId),
      { code: 'SQLITE_CONSTRAINT_CHECK' },
    );
  });

  test('rejects creating an event already over capacity', () => {
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO events (name, venue, starts_at, capacity, seats_booked) VALUES (?, ?, ?, ?, ?)')
          .run('Broken', 'Nowhere', nowIso(), 3, 4),
      { code: 'SQLITE_CONSTRAINT_CHECK' },
    );
  });
});

describe('other schema guards', () => {
  test('capacity must be positive', () => {
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO events (name, venue, starts_at, capacity) VALUES (?, ?, ?, ?)')
          .run('Empty', 'Nowhere', nowIso(), 0),
      { code: 'SQLITE_CONSTRAINT_CHECK' },
    );
  });

  test('bookings must point at a real event (foreign_keys pragma is on)', () => {
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO bookings (reference, event_id, attendee_name, attendee_email, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run('NOEVENT', 999, 'Ghost', 'ghost@example.com', 1, nowIso()),
      { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
    );
  });

  test('booking status is a closed set', () => {
    const eventId = insertEvent(db, { capacity: 5 });
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO bookings (reference, event_id, attendee_name, attendee_email, quantity, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run('BADSTATUS', eventId, 'A', 'a@example.com', 1, nowIso(), 'pending'),
      { code: 'SQLITE_CONSTRAINT_CHECK' },
    );
  });
});
