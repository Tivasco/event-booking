// The live demonstration of the core guarantee: fire N truly concurrent
// booking requests over real HTTP at an event with ONE seat left, and show
// that exactly one wins — in the HTTP responses and in the database.
//
//   npm run demo:concurrency          (25 racers)
//   npm run demo:concurrency -- 100   (100 racers)
//
// Uses the real app database, so the sold-out demo event is visible in the
// UI afterwards. Exits non-zero if the guarantee were ever violated.

import { once } from 'node:events';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

const racerCount = Number(process.argv[2] ?? 25);
const db = openDb();

const { lastInsertRowid } = db
  .prepare('INSERT INTO events (name, venue, starts_at, capacity) VALUES (?, ?, ?, 1)')
  .run(
    `Concurrency Demo ${new Date().toISOString().slice(11, 19)} — one seat left`,
    'The Terminal',
    new Date(Date.now() + 86_400_000).toISOString(),
  );
const eventId = Number(lastInsertRowid);

const server = createApp(db).listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/events/${eventId}/bookings`;

console.log(`\nEvent ${eventId} created with capacity 1.`);
console.log(`Firing ${racerCount} concurrent POST ${url} ...\n`);

const racers = await Promise.all(
  Array.from({ length: racerCount }, async (_, i) => {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: `Racer ${i + 1}`,
        email: `racer${i + 1}@example.com`,
        quantity: '1',
      }).toString(),
    });
    return { racer: i + 1, status: res.status, location: res.headers.get('location') };
  }),
);

const winners = racers.filter((r) => r.status === 303);
const losers = racers.filter((r) => r.status === 409);
const others = racers.filter((r) => r.status !== 303 && r.status !== 409);

console.log('┌───────────┬────────┬──────────────────────────────────────────┐');
for (const r of racers) {
  const outcome =
    r.status === 303
      ? `WON — booking ${r.location.split('/').pop()}`
      : r.status === 409
        ? 'refused: sold out'
        : 'UNEXPECTED';
  console.log(`│ Racer ${String(r.racer).padEnd(4)}│  ${r.status}   │ ${outcome.padEnd(41)}│`);
}
console.log('└───────────┴────────┴──────────────────────────────────────────┘');

const state = db
  .prepare(
    `SELECT e.capacity, e.seats_booked,
            (SELECT COUNT(*) FROM bookings b
              WHERE b.event_id = e.id AND b.status = 'confirmed') AS confirmed
       FROM events e WHERE e.id = ?`,
  )
  .get(eventId);

console.log(
  `\nHTTP outcomes:  ${winners.length} × 303 won, ${losers.length} × 409 sold out` +
    (others.length ? `, ${others.length} × UNEXPECTED` : ''),
);
console.log(
  `Database state: capacity=${state.capacity}, seats_booked=${state.seats_booked}, confirmed bookings=${state.confirmed}`,
);

const holds = winners.length === 1 && state.seats_booked === 1 && state.confirmed === 1 && others.length === 0;
console.log(holds ? '\nThe guarantee held: exactly one racer got the seat.' : '\nGUARANTEE VIOLATED — investigate immediately.');

server.close();
db.close();
process.exit(holds ? 0 : 1);
