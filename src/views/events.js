import { html, page, formatDate } from './html.js';
import { MAX_SEATS_PER_BOOKING } from '../domain/bookings.js';

export function eventListPage(events) {
  return page({
    title: 'Upcoming events',
    body: html`
      <h1>Upcoming events</h1>
      <p class="muted">Availability is live — what you see is what can actually be booked.</p>
      ${events.length === 0
        ? html`<section class="card"><p>No upcoming events right now. Check back soon.</p></section>`
        : html`<ul class="event-list">
            ${events.map((event) => eventCard(event))}
          </ul>`}
      ${lookupSection()}
    `,
  });
}

function eventCard(event) {
  return html`
    <li class="card event-card">
      <h2><a href="/events/${event.id}">${event.name}</a></h2>
      <p class="event-meta">${formatDate(event.startsAt)} · ${event.venue}</p>
      <div class="card-foot">
        ${availabilityBadge(event)}
        <a href="/events/${event.id}">View &amp; book</a>
      </div>
    </li>
  `;
}

export function availabilityBadge(event) {
  if (event.soldOut) return html`<span class="badge badge-gone">Sold out</span>`;
  if (event.seatsRemaining <= 5 && event.seatsRemaining < event.capacity) {
    return html`<span class="badge badge-low">
      Only ${event.seatsRemaining} ${event.seatsRemaining === 1 ? 'seat' : 'seats'} left
    </span>`;
  }
  return html`<span class="badge badge-open">${event.seatsRemaining} of ${event.capacity} seats available</span>`;
}

/**
 * The live-availability region on the detail page. htmx re-fetches it every
 * few seconds; outerHTML swap means the returned fragment must carry the same
 * hx-* attributes to keep the poll alive. Deliberately contains NO form —
 * a poll swap must never clobber what a visitor is typing.
 */
export function availabilitySection(event) {
  return html`
    <div
      id="availability"
      hx-get="/events/${event.id}/availability"
      hx-trigger="every 5s"
      hx-swap="outerHTML"
    >
      ${availabilityBadge(event)}
    </div>
  `;
}

export function eventDetailPage(event, formState = {}) {
  return page({
    title: event.name,
    body: html`
      <p><a href="/">← All events</a></p>
      <h1>${event.name}</h1>
      <p class="event-meta">${formatDate(event.startsAt)} · ${event.venue} · capacity ${event.capacity}</p>
      ${availabilitySection(event)}
      ${bookingArea(event, formState)}
    `,
  });
}

/**
 * The dual-mode booking region — one fragment for both worlds. The form is a
 * real HTML form (works with JavaScript disabled: plain POST, then a
 * redirect); the hx-* attributes let htmx take over when present and swap
 * this whole section in place, so a failed attempt re-renders with the
 * honest reason and the freshly-read availability. If the last seat vanished
 * while the visitor was typing, the re-render has no form to resubmit —
 * the page tells the truth the moment it knows it.
 */
export function bookingArea(event, { error, values = {} } = {}) {
  return html`
    <section id="booking-area" class="card">
      ${error && html`<p class="error" role="alert">${error}</p>`}
      ${bookingAreaBody(event, values)}
    </section>
  `;
}

function bookingAreaBody(event, values) {
  if (event.started) {
    return html`<p>Booking is closed — this event has already started.</p>`;
  }
  if (event.soldOut) {
    return html`<p>This event is sold out. If someone cancels, seats reappear here.</p>`;
  }
  const maxSeats = Math.min(event.seatsRemaining, MAX_SEATS_PER_BOOKING);
  return html`
    <h2>Book seats</h2>
    <form
      action="/events/${event.id}/bookings"
      method="post"
      hx-post="/events/${event.id}/bookings"
      hx-target="#booking-area"
      hx-swap="outerHTML"
    >
      <label for="booking-name">Your name</label>
      <input id="booking-name" name="name" required maxlength="200" value="${values.name ?? ''}" />
      <label for="booking-email">Email</label>
      <input id="booking-email" type="email" name="email" required maxlength="320" value="${values.email ?? ''}" />
      <label for="booking-quantity">Seats</label>
      <input
        id="booking-quantity"
        type="number"
        name="quantity"
        min="1"
        max="${maxSeats}"
        value="${values.quantity ?? 1}"
        required
      />
      <button type="submit">Book now</button>
    </form>
  `;
}

function lookupSection() {
  return html`
    <section class="lookup">
      <h2>Already booked?</h2>
      <form action="/bookings" method="get">
        <label for="lookup-reference">Booking reference</label>
        <input id="lookup-reference" name="reference" placeholder="e.g. K7MPQ2RA" required />
        <button type="submit">Find my booking</button>
      </form>
    </section>
  `;
}
