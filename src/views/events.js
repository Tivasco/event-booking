import { html, page, formatDate } from './html.js';

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

export function eventDetailPage(event) {
  return page({
    title: event.name,
    body: html`
      <p><a href="/">← All events</a></p>
      <h1>${event.name}</h1>
      <p class="event-meta">${formatDate(event.startsAt)} · ${event.venue} · capacity ${event.capacity}</p>
      ${availabilitySection(event)}
      ${eventStatusNote(event)}
    `,
  });
}

function eventStatusNote(event) {
  if (event.started) {
    return html`<p class="notice">This event has already started and can no longer be booked.</p>`;
  }
  if (event.soldOut) {
    return html`<p class="notice">This event is sold out. If someone cancels, seats reappear here.</p>`;
  }
  return null;
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
