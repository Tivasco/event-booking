/**
 * The closed set of expected failures. Anything not built from these
 * factories is a bug and surfaces as a logged 500 — never swallowed.
 */
export class DomainError extends Error {
  constructor(code, httpStatus, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const errors = {
  eventNotFound: () => new DomainError('EVENT_NOT_FOUND', 404, 'That event does not exist.'),
  eventStarted: () =>
    new DomainError('EVENT_STARTED', 409, 'This event has already started and can no longer be booked.'),
  soldOut: () =>
    new DomainError('SOLD_OUT', 409, 'This event is sold out — the last seat may have just been taken.'),
  notEnoughSeats: (remaining, requested) =>
    new DomainError(
      'NOT_ENOUGH_SEATS',
      409,
      `Only ${remaining} ${remaining === 1 ? 'seat is' : 'seats are'} left — you asked for ${requested}.`,
    ),
  bookingNotFound: () => new DomainError('BOOKING_NOT_FOUND', 404, 'No booking exists with that reference.'),
  alreadyCancelled: () => new DomainError('ALREADY_CANCELLED', 409, 'This booking was already cancelled.'),
  validation: (message) => new DomainError('VALIDATION', 422, message),
};
