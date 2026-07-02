import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestDb, insertEvent, startApp } from './helpers.js';

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

describe('everything else', () => {
  test('unknown routes get an honest 404 page', async () => {
    const res = await get('/nothing/here');
    assert.equal(res.status, 404);
    assert.match(await res.text(), /nothing at this address/);
  });
});
