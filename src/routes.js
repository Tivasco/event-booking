import { createEvents } from './domain/events.js';
import { createBookings, MAX_SEATS_PER_BOOKING } from './domain/bookings.js';
import { errors, DomainError } from './errors.js';
import { errorPage, html } from './views/html.js';
import { availabilitySection, bookingArea, eventDetailPage, eventListPage } from './views/events.js';
import { bookingPage } from './views/bookings.js';

const isHtmx = (req) => req.get('HX-Request') === 'true';

export function registerRoutes(app, db, options = {}) {
  const events = createEvents(db, options);
  const bookings = createBookings(db, options);

  app.get('/', (req, res) => {
    res.send(String(eventListPage(events.listUpcoming())));
  });

  app.get('/events/:id', (req, res) => {
    res.send(String(eventDetailPage(mustFindEvent(events, req.params.id))));
  });

  app.get('/events/:id/availability', (req, res) => {
    res.send(String(availabilitySection(mustFindEvent(events, req.params.id))));
  });

  app.post('/events/:id/bookings', (req, res) => {
    const event = mustFindEvent(events, req.params.id);
    res.set('Vary', 'HX-Request'); // same URL answers htmx and plain forms differently

    const { values, problem } = parseBookingForm(req.body ?? {});
    if (problem) return sendBookingFailure(req, res, event, values, problem, 422);

    try {
      const booking = bookings.book({
        eventId: event.id,
        quantity: values.quantity,
        name: values.name,
        email: values.email,
      });
      const url = `/bookings/${booking.reference}`;
      // htmx follows a real 3xx transparently and would swap the confirmation
      // page inside the form; HX-Redirect makes it a full navigation instead.
      // The no-JS path gets the classic POST → redirect → GET.
      if (isHtmx(req)) return res.set('HX-Redirect', url).end();
      return res.redirect(303, url);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      // Losing a race is an expected outcome, not a crash: re-read the event
      // so the re-rendered page shows the availability that beat us.
      return sendBookingFailure(req, res, events.getById(event.id), values, err.message, err.httpStatus);
    }
  });

  app.get('/bookings/:reference', (req, res) => {
    const booking = bookings.getByReference(normalizeReference(req.params.reference));
    if (!booking) throw errors.bookingNotFound();
    res.send(String(bookingPage(booking)));
  });

  // Pathless catch-all: anything not routed above is honestly a 404.
  app.use((req, res) => {
    res.status(404).send(String(errorPage({ title: 'Page not found', message: 'There is nothing at this address.' })));
  });

  // Every failure exits through here. Expected domain errors get their honest
  // status and message; anything unexpected is logged in full and reported as
  // a plain 500 — never swallowed, never leaked as a stack trace.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof DomainError) {
      if (isHtmx(req)) return res.status(err.httpStatus).send(String(html`<p class="error" role="alert">${err.message}</p>`));
      return res.status(err.httpStatus).send(String(errorPage({ title: 'That didn’t work', message: err.message })));
    }
    console.error(err);
    const message = 'Something went wrong on our side. Nothing was booked.';
    if (isHtmx(req)) return res.status(500).send(String(html`<p class="error" role="alert">${message}</p>`));
    res.status(500).send(String(errorPage({ title: 'Something went wrong', message })));
  });
}

function mustFindEvent(events, rawId) {
  const id = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
  const event = events.getById(id);
  if (!event) throw errors.eventNotFound();
  return event;
}

function normalizeReference(raw) {
  // References are read out loud and typed back in — accept any casing.
  return String(raw).trim().toUpperCase();
}

function sendBookingFailure(req, res, event, values, message, status) {
  const state = { error: message, values };
  if (isHtmx(req)) return res.status(status).send(String(bookingArea(event, state)));
  return res.status(status).send(String(eventDetailPage(event, state)));
}

function parseBookingForm(body) {
  const values = {
    name: String(body.name ?? '').trim(),
    email: String(body.email ?? '').trim(),
    quantity: String(body.quantity ?? '').trim(),
  };

  const problems = [];
  if (!values.name) problems.push('Please tell us your name.');
  else if (values.name.length > 200) problems.push('That name is too long.');

  if (!values.email || values.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    problems.push('Please enter a valid email address.');
  }

  // SQLite coerces types generously, so the route — not the CHECK constraint —
  // is where input gets strict: digits only, whole number, sane bounds.
  const quantity = /^\d+$/.test(values.quantity) ? Number(values.quantity) : NaN;
  if (!(quantity >= 1)) problems.push('Seat quantity must be a whole number of at least 1.');
  else if (quantity > MAX_SEATS_PER_BOOKING) {
    problems.push(`Bookings are limited to ${MAX_SEATS_PER_BOOKING} seats each.`);
  }

  if (problems.length > 0) return { values, problem: problems.join(' ') };
  return { values: { ...values, quantity } };
}
