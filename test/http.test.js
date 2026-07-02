import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestDb, insertEvent, startApp, postForm, readIntegrity, assertIntegrity } from './helpers.js';

let db;
let baseUrl;
let close;

before(async () => {
  db = makeTestDb();
  ({ baseUrl, close } = await startApp(db));
});

after(() => close());

beforeEach(() => {
  db.prepare('DELETE FROM bookings').run();
  db.prepare('DELETE FROM events').run();
});

const get = (path, headers = {}) => fetch(baseUrl + path, { headers, redirect: 'manual' });

describe('browsing (R1)', () => {
  test('lists upcoming events with the essentials, soonest first, past events excluded', async () => {
    insertEvent(db, { name: 'Later Workshop', venue: 'Hall B', startsInDays: 9, capacity: 10, booked: 2 });
    insertEvent(db, { name: 'Sooner Meetup', venue: 'Hall A', startsInDays: 2, capacity: 20 });
    insertEvent(db, { name: 'Yesterday Retro', startsInDays: -1, capacity: 20 });

    const res = await get('/');
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.ok(body.indexOf('Sooner Meetup') < body.indexOf('Later Workshop'), 'soonest event must come first');
    assert.ok(!body.includes('Yesterday Retro'), 'past events must not be listed');
    assert.match(body, /Hall B/);
    assert.match(body, /8 of 10 seats available/);
  });

  test('shows an honest empty state when nothing is upcoming', async () => {
    const res = await get('/');
    assert.match(await res.text(), /No upcoming events/);
  });

  test('flags a sold-out event in the list instead of inviting a click into disappointment', async () => {
    insertEvent(db, { name: 'Full House', capacity: 3, booked: 3 });
    assert.match(await (await get('/')).text(), /Sold out/);
  });

  test('escapes untrusted text everywhere it renders', async () => {
    insertEvent(db, { name: '<script>alert("xss")</script>', venue: 'B&B "Venue"', capacity: 5 });
    const body = await (await get('/')).text();
    assert.ok(!body.includes('<script>alert'), 'event names must be HTML-escaped');
    assert.match(body, /&lt;script&gt;/);
    assert.match(body, /B&amp;B &quot;Venue&quot;/);
  });
});

describe('event detail with live availability (R2)', () => {
  test('shows current availability and a polling region', async () => {
    const id = insertEvent(db, { name: 'Detail Event', capacity: 5, booked: 4 });
    const body = await (await get(`/events/${id}`)).text();

    assert.match(body, /Detail Event/);
    assert.match(body, /Only 1 seat left/);
    assert.match(body, new RegExp(`hx-get="/events/${id}/availability"`));
    assert.match(body, /hx-trigger="every 5s"/);
  });

  test('the availability fragment re-arms its own poll (outerHTML swap)', async () => {
    const id = insertEvent(db, { capacity: 5 });
    const body = await (await get(`/events/${id}/availability`)).text();
    assert.match(body, /hx-get=/, 'fragment must carry the hx attributes or polling dies after one swap');
    assert.match(body, /5 of 5 seats available/);
  });

  test('a sold-out event says so plainly', async () => {
    const id = insertEvent(db, { capacity: 2, booked: 2 });
    const body = await (await get(`/events/${id}`)).text();
    assert.match(body, /sold out/i);
  });

  test('a started event says booking is closed', async () => {
    const id = insertEvent(db, { startsInDays: -1, capacity: 5 });
    const body = await (await get(`/events/${id}`)).text();
    assert.match(body, /already started/);
  });

  test('unknown and malformed event ids are honest 404s', async () => {
    for (const path of ['/events/999', '/events/abc', '/events/1.5']) {
      const res = await get(path);
      assert.equal(res.status, 404, `${path} must 404`);
      assert.match(await res.text(), /does not exist/);
    }
  });
});

const validBooking = { name: 'Ada Lovelace', email: 'ada@example.com', quantity: '1' };

describe('making a booking (R3)', () => {
  test('plain form (no JavaScript): POST → 303 → confirmation page', async () => {
    const id = insertEvent(db, { name: 'Bookable Night', capacity: 5 });

    const res = await postForm(`${baseUrl}/events/${id}/bookings`, { ...validBooking, quantity: '2' });
    assert.equal(res.status, 303);
    const location = res.headers.get('location');
    assert.match(location, /^\/bookings\/[A-Z2-9]{8}$/);

    const body = await (await get(location)).text();
    assert.match(body, /Booking confirmed/);
    assert.match(body, /Bookable Night/);
    assert.match(body, /Ada Lovelace/);
    assert.match(body, new RegExp(location.split('/').pop()));
    assertIntegrity(assert, db, id);
    assert.equal(readIntegrity(db, id).seats_booked, 2);
  });

  test('htmx form: 200 + HX-Redirect header (a real 3xx would swap a page inside the form)', async () => {
    const id = insertEvent(db, { capacity: 5 });
    const res = await postForm(`${baseUrl}/events/${id}/bookings`, validBooking, { htmx: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('hx-redirect'), /^\/bookings\/[A-Z2-9]{8}$/);
  });

  test('validation failure re-renders the form with the reason and the typed values, no JS', async () => {
    const id = insertEvent(db, { capacity: 5 });
    const res = await postForm(`${baseUrl}/events/${id}/bookings`, { name: '', email: 'ada@example.com', quantity: 'two' });
    const body = await res.text();

    assert.equal(res.status, 422);
    assert.match(body, /<!doctype html>/, 'the no-JS path must get a whole page back');
    assert.match(body, /Please tell us your name\./);
    assert.match(body, /whole number of at least 1/);
    assert.match(body, /value="ada@example.com"/, 'typed values must survive the failure');
  });

  test('validation failure over htmx returns just the booking-area fragment', async () => {
    const id = insertEvent(db, { capacity: 5 });
    const res = await postForm(
      `${baseUrl}/events/${id}/bookings`,
      { ...validBooking, quantity: '0' },
      { htmx: true },
    );
    const body = await res.text();

    assert.equal(res.status, 422);
    assert.ok(!body.includes('<!doctype'), 'htmx gets a fragment, not a page');
    assert.match(body, /id="booking-area"/);
    assert.match(body, /whole number of at least 1/);
  });

  test('a greedy quantity is refused with the honest remaining count', async () => {
    const id = insertEvent(db, { capacity: 5, booked: 3 });
    const res = await postForm(`${baseUrl}/events/${id}/bookings`, { ...validBooking, quantity: '4' });
    assert.equal(res.status, 409);
    assert.match(await res.text(), /Only 2 seats are left — you asked for 4/);
    assert.equal(readIntegrity(db, id).seats_booked, 3, 'a refused attempt must not consume seats');
  });

  test('losing the last seat gets a calm 409 and a form-less re-render', async () => {
    const id = insertEvent(db, { capacity: 2, booked: 2 });
    const res = await postForm(`${baseUrl}/events/${id}/bookings`, validBooking, { htmx: true });
    const body = await res.text();

    assert.equal(res.status, 409);
    assert.match(body, /sold out — the last seat may have just been taken/);
    assert.ok(!body.includes('<form'), 'a sold-out re-render must not offer the form again');
  });

  test('booking a started event is refused', async () => {
    const id = insertEvent(db, { startsInDays: -1, capacity: 5 });
    const res = await postForm(`${baseUrl}/events/${id}/bookings`, validBooking);
    assert.equal(res.status, 409);
    assert.match(await res.text(), /already started/);
  });

  test('booking a nonexistent event is a 404', async () => {
    const res = await postForm(`${baseUrl}/events/999/bookings`, validBooking);
    assert.equal(res.status, 404);
  });

  test('caps seats per booking as interface policy', async () => {
    const id = insertEvent(db, { capacity: 50 });
    const res = await postForm(`${baseUrl}/events/${id}/bookings`, { ...validBooking, quantity: '11' });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /limited to 10 seats/);
  });
});

describe('viewing a booking (R5)', () => {
  test('the booking page is reachable by reference, any casing', async () => {
    const id = insertEvent(db, { capacity: 5 });
    const create = await postForm(`${baseUrl}/events/${id}/bookings`, validBooking);
    const reference = create.headers.get('location').split('/').pop();

    const res = await get(`/bookings/${reference.toLowerCase()}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(reference));
  });

  test('an unknown reference is an honest 404', async () => {
    const res = await get('/bookings/XXXXXXXX');
    assert.equal(res.status, 404);
    assert.match(await res.text(), /No booking exists/);
  });

  test('the lookup form canonicalizes and redirects to the booking', async () => {
    const res = await get('/bookings?reference=+ab2cd3ef+');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/bookings/AB2CD3EF');

    const empty = await get('/bookings?reference=');
    assert.equal(empty.headers.get('location'), '/');
  });
});

describe('cancelling a booking (R5)', () => {
  async function bookOne(eventId, quantity = '1') {
    const res = await postForm(`${baseUrl}/events/${eventId}/bookings`, { ...validBooking, quantity });
    return res.headers.get('location').split('/').pop();
  }

  test('cancel returns the seats and the page says so', async () => {
    const id = insertEvent(db, { capacity: 5 });
    const reference = await bookOne(id, '3');

    const res = await postForm(`${baseUrl}/bookings/${reference}/cancel`, {});
    assert.equal(res.status, 303);

    const body = await (await get(`/bookings/${reference}`)).text();
    assert.match(body, /Booking cancelled/);
    assert.match(body, /back in the\s+pool/);
    assert.ok(!body.includes('/cancel"'), 'a cancelled booking must not offer cancelling again');
    assert.equal(readIntegrity(db, id).seats_booked, 0);
    assertIntegrity(assert, db, id);
  });

  test('a freed seat is immediately bookable by someone else', async () => {
    const id = insertEvent(db, { capacity: 1 });
    const reference = await bookOne(id);

    const refused = await postForm(`${baseUrl}/events/${id}/bookings`, { ...validBooking, name: 'Grace' });
    assert.equal(refused.status, 409);

    await postForm(`${baseUrl}/bookings/${reference}/cancel`, {});
    const won = await postForm(`${baseUrl}/events/${id}/bookings`, { ...validBooking, name: 'Grace' });
    assert.equal(won.status, 303);
    assertIntegrity(assert, db, id);
  });

  test('double-cancel tells the truth instead of pretending to succeed', async () => {
    const id = insertEvent(db, { capacity: 5 });
    const reference = await bookOne(id);

    await postForm(`${baseUrl}/bookings/${reference}/cancel`, {});
    const again = await postForm(`${baseUrl}/bookings/${reference}/cancel`, {});
    assert.equal(again.status, 409);
    assert.match(await again.text(), /already cancelled/);
    assert.equal(readIntegrity(db, id).seats_booked, 0, 'seats must be returned exactly once');
  });

  test('cancelling an unknown reference is a 404', async () => {
    const res = await postForm(`${baseUrl}/bookings/XXXXXXXX/cancel`, {});
    assert.equal(res.status, 404);
  });
});

describe('everything else', () => {
  test('unknown routes get an honest 404 page', async () => {
    const res = await get('/nothing/here');
    assert.equal(res.status, 404);
    assert.match(await res.text(), /nothing at this address/);
  });
});
