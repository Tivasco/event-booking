# Seatwise — Event Booking Platform

A small event-booking app built around one non-negotiable property: **it never sells the same seat twice, no matter how many requests arrive at once.** Every choice below — database, stack, page design — exists to make that guarantee real, provable, and easy to point at.

Stack: **SQLite** (via better-sqlite3) · **Node 22 + Express 5** · **server-rendered HTML + htmx** (vendored). Plain JavaScript, zero build step, no Docker.

## Quick start

Prerequisites: Node ≥ 22.

```sh
npm install
npm run seed     # sample events in every state
npm start        # http://localhost:3000
```

The seed includes an event with **one seat left** ("SQLite in Production"), a sold-out one, and a past one, so every state is visible immediately. `PORT` moves the server; `DB_PATH` moves the database (default `data/bookings.db`).

## Prove the guarantee

```sh
npm run demo:concurrency          # 25 concurrent HTTP bookings race for 1 seat
npm run demo:concurrency -- 100   # same, with 100
npm test                          # full suite — real database, real HTTP, no mocks
```

The demo prints every racer's outcome and the final database state: exactly one wins, everyone else gets a calm refusal, and the database agrees. It exits non-zero if the guarantee were ever violated.

The test suite proves it three ways, because each tier alone has a blind spot:

1. **In-process HTTP race** — 50 concurrent requests for the last seat through the full stack: one confirmation, 49 honest 409s. Proves the shipped configuration end to end.
2. **Multi-process writers** — four OS processes with their own database connections, released by a barrier and pacing their attempts so their time windows provably overlap (asserted from timestamps). This is the tier that matters most on this stack: better-sqlite3 is synchronous, so *inside one Node process even broken read-check-write code cannot interleave* — an in-process test alone would pass by accident. Across processes, SQLite's write lock and the conditional UPDATE are the only defense, and exactly `capacity` seats get sold. It's also "several app instances behind a load balancer", made executable.
3. **A negative control** — a deliberately naive implementation (read, `await`, write) that the harness catches overselling 30 seats on a 1-seat event. If the harness couldn't detect failure, green tests would mean nothing.

Plus mixed-quantity bursts, an interleaved book/cancel storm with invariant checks after every wave, concurrent double-cancel, and a direct attack on the schema backstop.

## Where the guarantee lives

In the data layer, twice over — `src/domain/bookings.js` and `src/schema.sql`:

**1. The claim is one SQL statement.** The booking transaction claims seats with an atomic conditional UPDATE:

```sql
UPDATE events SET seats_booked = seats_booked + :quantity
 WHERE id = :eventId AND starts_at > :now
   AND seats_booked + :quantity <= capacity
```

The WHERE clause *is* the availability check — check and claim can't be separated, so there is no read-then-write window at any layer. Zero rows affected means no seat; a follow-up read inside the same transaction picks the honest error (doesn't exist / already started / "only N seats left, you asked for Q"). SQLite allows one write transaction at a time — across processes too — so concurrent claims serialize and the loser re-evaluates against the committed value.

**2. The schema refuses to overbook anyway.**

```sql
CONSTRAINT seats_within_capacity CHECK (seats_booked >= 0 AND seats_booked <= capacity)
```

Delete the WHERE guard and the database still rejects the commit — the tests attack this path directly with raw SQL. One invariant *can't* live in a constraint: "counter equals the sum of confirmed bookings" spans two tables, so the transaction maintains it and the storm tests verify it after every wave. Knowing which guarantee can live where is half the design.

The claim and the booking INSERT share one immediate transaction: they commit or roll back together, so a crash mid-booking cannot leak a claimed seat — and because booking confirms instantly (no payments, no holds), **no pending state exists to get stuck**. Cancelling mirrors it: the `status = 'confirmed'` guard means any number of concurrent cancels return the seats exactly once.

## Design decisions (and what I rejected)

**SQLite** — seat allocation is a transactional, cross-record-invariant problem; it needs ACID, serialized writes, and constraints, all of which SQLite provides in-process with zero infrastructure: reviewers run this with `npm install && npm start`, nothing else. The write volume of a real box office fits comfortably inside a single writer. *Rejected:* PostgreSQL — equally correct, and the claim statement would be identical SQL, but it buys nothing at this scale while costing a Docker dependency; it's the named migration path, not the starting point. MongoDB — cross-document invariant enforcement is the weak spot of the model. Redis-as-truth — atomic, wrong durability story for bookings. Application-level locks — die at two processes; the multi-process test exists to prove this design doesn't.

**Synchronous driver (better-sqlite3)** — a booking transaction is a microseconds-long critical section; synchronous execution means no interleaving is even possible inside it, and there's no connection-pool machinery to reason about. The cost — it blocks the event loop per write — is the honestly-named first strain point at scale (below). Correctness deliberately does *not* depend on it: that's what the multi-process tier proves.

**Server-rendered HTML + htmx** — this app is three views of server-owned truth. A SPA duplicates that truth into client state — precisely the thing that goes stale and lies about availability. Here the server renders what the database knows, htmx (14 kB, vendored) adds the two behaviors that need liveness — a polling availability badge and in-place form failure — and every form is a real HTML form first: **the whole app works with JavaScript disabled**. Failures keep honest HTTP statuses (409/422); htmx is configured to render those bodies while genuine 500s never eat the form. The polled fragment deliberately excludes the form, so a refresh can never clobber what you're typing.

**A `seats_booked` counter, not `COUNT(bookings)` per read** — O(1) availability reads and a single lockable row for the claim. The trade-off is denormalization; it's contained because the counter only ever changes inside the two transactions, and reconciliation is asserted throughout the suite. If it ever drifted, the CHECK still caps it: you'd under-sell, never over-sell.

**Plain JavaScript, no ORM, no framework beyond Express** — the correctness story is a specific SQL statement; an ORM would hide the thing that matters most. Zero build step means nothing sits between the source and what runs. Express earns its place doing routing and form parsing; a template engine would not (the views are escape-by-default template-literal functions, ~40 lines of primitives).

**Booking reference as the access handle** — 8 crypto-random characters from an unambiguous alphabet (~8.5 × 10¹¹), no accounts: matches the brief's lightweight-identity scope. Collisions retry inside the transaction without releasing the claimed seat.

## Honest answers

- **Two people, one seat left:** one confirmation, one calm "the last seat may have just been taken" — decided by the database, demonstrated by `npm run demo:concurrency`, and shown live in the UI (the availability badge polls, and a lost race re-renders the booking area with the truth and no form).
- **A held-but-unconfirmed seat:** cannot exist. Claim + booking are one transaction; there is no hold state, so nothing to expire and nowhere for a seat to get stuck.
- **At 10× traffic:** reads dominate and SQLite in WAL mode serves them concurrently; the strain point is the single-writer ceiling, and before that, the synchronous driver blocking the event loop per write. First response: move reads aside (they already don't block writers) and keep write transactions single-statement-short, which this design does. Real growth: keep the exact same claim-and-constraint design and move it to Postgres — the SQL transfers almost verbatim; it's a connection-layer change, not a redesign. What I would *not* do is shard one event's seats or cache availability as truth: both reintroduce double-booking as a distributed-systems problem.

## Deliberately not built

Payments, emails, admin panels, accounts, seat holds/expiry, seat maps, WebSockets, duplicate-attendee prevention (the same email may book twice — the brief doesn't forbid it, and guessing would add error surface). Scope discipline is part of the brief.

## Layout

```
src/schema.sql              # the CHECK backstop lives here
src/domain/bookings.js      # THE file: claim + cancel transactions
src/domain/events.js        # read-only queries
src/routes.js               # thin: parse → validate → domain → render
src/views/                  # escape-by-default template-literal views
test/concurrency.test.js    # the three-tier proof
test/multiprocess.worker.js # one parallel writer
scripts/concurrency-demo.js # the live race
```

Other commands: `npm run dev` (watch mode) · `npm run seed` (reset sample data).
