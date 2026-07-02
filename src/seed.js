import { openDb, nowIso } from './db.js';
import { newReference } from './domain/reference.js';

// Crafted so every state is visible on first load: plenty of seats, a
// single seat left (the concurrency target), sold out (must not invite a
// booking), and one already in the past (must not be listed). Pre-booked
// seats get real booking rows so the counter reconciles with the bookings
// table from the very first byte of data.
const SEED_EVENTS = [
  { name: 'Design Systems Workshop', venue: 'Studio 2, Riverside House', startsInDays: 7, capacity: 30, booked: 12 },
  { name: 'SQLite in Production', venue: 'The Old Print Hall', startsInDays: 3, capacity: 5, booked: 4 },
  { name: 'Indie Makers Meetup', venue: 'Corner Café Loft', startsInDays: 1, capacity: 2, booked: 2 },
  { name: 'Intro to Event Sourcing', venue: 'Harbour Conference Centre', startsInDays: 14, capacity: 50, booked: 3 },
  { name: 'Last Month’s Retro', venue: 'The Old Print Hall', startsInDays: -7, capacity: 20, booked: 0 },
];

export function seed(db) {
  const insertEvent = db.prepare(
    'INSERT INTO events (name, venue, starts_at, capacity, seats_booked) VALUES (?, ?, ?, ?, ?)',
  );
  const insertBooking = db.prepare(
    'INSERT INTO bookings (reference, event_id, attendee_name, attendee_email, quantity, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  );

  db.transaction(() => {
    db.prepare('DELETE FROM bookings').run();
    db.prepare('DELETE FROM events').run();
    for (const event of SEED_EVENTS) {
      const startsAt = new Date(Date.now() + event.startsInDays * 86_400_000).toISOString();
      const { lastInsertRowid } = insertEvent.run(event.name, event.venue, startsAt, event.capacity, event.booked);
      for (let i = 1; i <= event.booked; i += 1) {
        insertBooking.run(newReference(), Number(lastInsertRowid), `Seed Attendee ${i}`, `attendee${i}@example.com`, nowIso());
      }
    }
  })();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const db = openDb();
  seed(db);
  console.log(`Seeded ${SEED_EVENTS.length} events into ${db.name}`);
  console.log('"SQLite in Production" has exactly one seat left — the concurrency target.');
  db.close();
}
