// Worker for the multi-process concurrency proof. Each worker is a separate
// OS process with its OWN database connection, hammering the booking
// transaction in a tight loop. Nothing about Node's event loop protects
// these writers from each other — only SQLite's write lock and the
// conditional UPDATE do.
//
// All workers spin until the parent creates the "go" file, so they start
// claiming at the same instant instead of finishing in spawn order.
//
// argv: <dbPath> <goFile> <eventId> <attempts> <label>

import { existsSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { createBookings } from '../src/domain/bookings.js';

const [dbPath, goFile, eventId, attempts, label] = process.argv.slice(2);
if (!dbPath || !goFile || !eventId || !attempts || !label) {
  console.error('usage: node multiprocess.worker.js <dbPath> <goFile> <eventId> <attempts> <label>');
  process.exit(1);
}

const db = openDb(dbPath);
const bookings = createBookings(db);

const deadline = Date.now() + 10_000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) {
    console.error('go file never appeared');
    process.exit(1);
  }
}

const result = { successes: 0, refused: 0, unexpected: [], firstAttemptAt: 0, lastAttemptAt: 0 };

// ~1ms between attempts: a synchronous transaction takes microseconds, so
// without spacing the first worker to win the lock re-acquires it before the
// others are ever scheduled and "wins" the whole event uncontended. Spaced
// attempts keep all workers active in the same window — the parent asserts
// that overlap from the reported timestamps.
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

for (let i = 0; i < Number(attempts); i += 1) {
  const at = Date.now();
  if (i === 0) result.firstAttemptAt = at;
  result.lastAttemptAt = at;
  try {
    bookings.book({
      eventId: Number(eventId),
      quantity: 1,
      name: `${label} attempt ${i}`,
      email: `${label.toLowerCase()}${i}@example.com`,
    });
    result.successes += 1;
  } catch (err) {
    if (err.code === 'SOLD_OUT' || err.code === 'NOT_ENOUGH_SEATS') result.refused += 1;
    else result.unexpected.push(err.code ?? err.message);
  }
  Atomics.wait(sleepBuffer, 0, 0, 1); // synchronous ~1ms pause
}

db.close();
process.stdout.write(JSON.stringify(result));
