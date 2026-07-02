import { html, page, formatDate } from './html.js';

export function bookingPage(booking, { notice } = {}) {
  const cancelled = booking.status === 'cancelled';
  return page({
    title: `Booking ${booking.reference}`,
    body: html`
      <p><a href="/">← All events</a></p>
      <h1>${cancelled ? 'Booking cancelled' : 'Booking confirmed'}</h1>
      ${notice && html`<p class="notice">${notice}</p>`}
      ${cancelled
        ? html`<p>The ${booking.quantity === 1 ? 'seat is' : `${booking.quantity} seats are`} back in the
            pool for anyone to book.</p>`
        : html`<p>Keep this reference — it’s how you view or cancel your booking.</p>`}
      <p class="reference-code">${booking.reference}</p>
      <dl class="details">
        <dt>Event</dt>
        <dd><a href="/events/${booking.event.id}">${booking.event.name}</a></dd>
        <dt>When</dt>
        <dd>${formatDate(booking.event.startsAt)}</dd>
        <dt>Venue</dt>
        <dd>${booking.event.venue}</dd>
        <dt>Seats</dt>
        <dd>${booking.quantity}</dd>
        <dt>Booked by</dt>
        <dd>${booking.attendeeName} (${booking.attendeeEmail})</dd>
        <dt>Status</dt>
        <dd>${booking.status}</dd>
      </dl>
    `,
  });
}
