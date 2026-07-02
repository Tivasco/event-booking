import { mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { openDb, nowIso } from '../src/db.js';
import { createApp } from '../src/app.js';

/**
 * Every suite gets a real SQLite file in a temp dir — never :memory: — because
 * the multi-process tests need a file other processes can open, and because
 * the shipped configuration (WAL etc.) should be what the tests exercise.
 */
export function makeTestDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'booking-test-'));
  return openDb(path.join(dir, 'test.db'));
}

let fixtureCounter = 0;

export function insertEvent(db, { name = 'Test Event', venue = 'Test Hall', startsInDays = 3, capacity, booked = 0 } = {}) {
  const startsAt = new Date(Date.now() + startsInDays * 86_400_000).toISOString();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO events (name, venue, starts_at, capacity, seats_booked) VALUES (?, ?, ?, ?, ?)')
    .run(name, venue, startsAt, capacity, booked);
  const eventId = Number(lastInsertRowid);
  // Pre-booked seats get real booking rows so the counter always reconciles.
  for (let i = 1; i <= booked; i += 1) {
    db.prepare(
      'INSERT INTO bookings (reference, event_id, attendee_name, attendee_email, quantity, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    ).run(`FIXTURE${(fixtureCounter += 1)}`, eventId, `Existing ${i}`, `existing${i}@example.com`, nowIso());
  }
  return eventId;
}

/**
 * The invariant every concurrency test asserts after the dust settles:
 * the denormalized counter, the booking rows, and the capacity all agree.
 */
export function readIntegrity(db, eventId) {
  return db
    .prepare(
      `SELECT e.capacity,
              e.seats_booked,
              COALESCE((SELECT SUM(b.quantity) FROM bookings b
                         WHERE b.event_id = e.id AND b.status = 'confirmed'), 0) AS confirmed_seats
         FROM events e WHERE e.id = ?`,
    )
    .get(eventId);
}

/** Real HTTP server on an ephemeral port — tests talk to it with fetch. */
export async function startApp(db, options = {}) {
  const server = createApp(db, options).listen(0);
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Form-encoded POST, redirects left unfollowed so tests can assert on them. */
export function postForm(url, fields, { htmx = false } = {}) {
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(htmx ? { 'HX-Request': 'true' } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

export function assertIntegrity(assert, db, eventId) {
  const { capacity, seats_booked, confirmed_seats } = readIntegrity(db, eventId);
  assert.ok(seats_booked <= capacity, `counter ${seats_booked} exceeds capacity ${capacity}`);
  assert.equal(seats_booked, confirmed_seats, 'counter must reconcile with SUM(quantity) of confirmed bookings');
}
