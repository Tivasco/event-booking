import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { makeTestDb, insertEvent, readIntegrity, assertIntegrity, startApp, postForm } from './helpers.js';
import { nowIso } from '../src/db.js';

const run = promisify(execFile);
const workerPath = fileURLToPath(new URL('./multiprocess.worker.js', import.meta.url));

let db;
beforeEach(() => {
  db = makeTestDb();
});

/**
 * THE decisive proof. An in-process test cannot be fully trusted here:
 * better-sqlite3 is synchronous, so inside one Node process even a broken
 * read-check-write implementation never interleaves. These workers are
 * separate OS processes with separate database connections — genuinely
 * parallel writers, scheduled by the OS, where SQLite's write lock and the
 * conditional UPDATE are the only defense. This is also exactly the shape
 * of "several app instances behind a load balancer".
 */
describe('multi-process writers (the guarantee lives in the database)', () => {
  test('4 parallel processes × 25 attempts at a 5-seat event: exactly 5 seats sold', async (t) => {
    const eventId = insertEvent(db, { capacity: 5 });
    const dbPath = db.name;
    const goFile = path.join(path.dirname(dbPath), 'go');

    // Spawn all workers first; they spin on the go file so their claim loops
    // start at the same instant rather than running in spawn order.
    const workers = ['A', 'B', 'C', 'D'].map((label) =>
      run(process.execPath, [workerPath, dbPath, goFile, String(eventId), '25', `Worker ${label}`]),
    );
    await setTimeout(300); // let every process boot and reach the barrier
    writeFileSync(goFile, 'go');
    const results = (await Promise.all(workers)).map(({ stdout }) => JSON.parse(stdout));
    t.diagnostic(`successes by worker: ${results.map((r, i) => `${'ABCD'[i]}=${r.successes}`).join(' ')}`);

    // The race must be real: every worker's attempt window has to overlap
    // the others', otherwise this test degenerates into sequential writers.
    const lastStart = Math.max(...results.map((r) => r.firstAttemptAt));
    const firstEnd = Math.min(...results.map((r) => r.lastAttemptAt));
    assert.ok(lastStart < firstEnd, 'workers must be attempting bookings simultaneously');

    const successes = results.reduce((n, r) => n + r.successes, 0);
    const refused = results.reduce((n, r) => n + r.refused, 0);
    const unexpected = results.flatMap((r) => r.unexpected);

    assert.deepEqual(unexpected, [], 'no worker may fail for any reason other than an honest refusal');
    assert.equal(successes, 5, 'exactly capacity bookings must win');
    assert.equal(refused, 95, 'every other attempt must be honestly refused');

    const { seats_booked, confirmed_seats, capacity } = readIntegrity(db, eventId);
    assert.equal(seats_booked, capacity);
    assert.equal(confirmed_seats, capacity, 'booking rows must agree with the counter');
  });
});

/**
 * End-to-end tier: the same property through the whole shipped stack —
 * HTTP parsing, routing, validation, rendering. What this tier alone cannot
 * prove (that correctness doesn't hinge on Node's single thread) is exactly
 * what the multi-process tier above exists for.
 */
describe('in-process HTTP race (the shipped configuration, end to end)', () => {
  test('50 concurrent requests for the last seat: one confirmation, 49 honest refusals', async () => {
    const eventId = insertEvent(db, { capacity: 1 });
    const { baseUrl, close } = await startApp(db);
    try {
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          postForm(`${baseUrl}/events/${eventId}/bookings`, {
            name: `Racer ${i}`,
            email: `racer${i}@example.com`,
            quantity: '1',
          }),
        ),
      );

      const winners = responses.filter((r) => r.status === 303);
      const losers = responses.filter((r) => r.status === 409);
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 49);
      for (const loser of losers.slice(0, 3)) {
        assert.match(await loser.text(), /sold out — the last seat may have just been taken/);
      }

      const { seats_booked, confirmed_seats } = readIntegrity(db, eventId);
      assert.equal(seats_booked, 1, 'the database must agree with the HTTP responses');
      assert.equal(confirmed_seats, 1);
    } finally {
      await close();
    }
  });

  test('a mixed-quantity burst never exceeds capacity and stays reconciled', async () => {
    const eventId = insertEvent(db, { capacity: 7 });
    const { baseUrl, close } = await startApp(db);
    try {
      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          postForm(`${baseUrl}/events/${eventId}/bookings`, {
            name: `Group ${i}`,
            email: `group${i}@example.com`,
            quantity: String((i % 3) + 1),
          }),
        ),
      );

      for (const r of responses) {
        assert.ok(r.status === 303 || r.status === 409, `unexpected status ${r.status}`);
      }
      const { capacity, seats_booked } = readIntegrity(db, eventId);
      assert.ok(seats_booked <= capacity);
      assertIntegrity(assert, db, eventId);
    } finally {
      await close();
    }
  });

  test('an interleaved book/cancel storm holds the invariants after every wave', async () => {
    const eventId = insertEvent(db, { capacity: 3 });
    const { baseUrl, close } = await startApp(db);
    try {
      let previousWinners = [];
      for (let wave = 0; wave < 5; wave += 1) {
        const bookingAttempts = Array.from({ length: 10 }, (_, i) =>
          postForm(`${baseUrl}/events/${eventId}/bookings`, {
            name: `Wave ${wave} #${i}`,
            email: `w${wave}n${i}@example.com`,
            quantity: '1',
          }),
        );
        const cancels = previousWinners.map((ref) => postForm(`${baseUrl}/bookings/${ref}/cancel`, {}));

        const results = await Promise.all([...bookingAttempts, ...cancels]);
        assertIntegrity(assert, db, eventId);

        previousWinners = results
          .filter((r) => r.url.includes('/events/') && r.status === 303)
          .map((r) => r.headers.get('location').split('/').pop());
      }
    } finally {
      await close();
    }
  });
});

/**
 * Negative control: prove the harness can detect overbooking at all, by
 * running a deliberately naive implementation — read availability, decide in
 * application code, then write — with the await point every async data layer
 * has between its read and its write. If this test ever starts passing for
 * the wrong reason (no oversell), the harness has gone blind and the green
 * tests above mean nothing.
 */
describe('negative control (a naive read-check-write implementation oversells)', () => {
  async function naiveBook(eventId, label) {
    const event = db.prepare('SELECT capacity, seats_booked FROM events WHERE id = ?').get(eventId);
    if (event.capacity - event.seats_booked < 1) throw new Error('sold out');

    await new Promise((resolve) => setImmediate(resolve)); // the gap

    db.prepare('UPDATE events SET seats_booked = ? WHERE id = ?').run(event.seats_booked + 1, eventId);
    db.prepare(
      'INSERT INTO bookings (reference, event_id, attendee_name, attendee_email, quantity, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    ).run(`NAIVE${label}`, eventId, `Racer ${label}`, `racer${label}@example.com`, nowIso());
  }

  test('30 concurrent naive bookings of the last seat all "succeed"', async () => {
    const eventId = insertEvent(db, { capacity: 1 });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => naiveBook(eventId, i)),
    );
    const sold = outcomes.filter((o) => o.status === 'fulfilled').length;

    const { capacity, seats_booked, confirmed_seats } = readIntegrity(db, eventId);
    assert.ok(sold > capacity, `expected the naive code to oversell; it sold ${sold} of ${capacity}`);
    assert.ok(
      confirmed_seats > capacity,
      'the reconciliation query must expose the overbooking the counter hides',
    );
    // The stale derived write keeps the counter innocently at 1 — inside the
    // CHECK constraint — while 30 people hold confirmed bookings. This is
    // precisely the failure mode the atomic conditional UPDATE removes.
    assert.equal(seats_booked, 1);
  });
});
