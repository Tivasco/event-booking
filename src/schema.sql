-- The data-layer backstop lives here: seats_within_capacity makes overbooking
-- impossible even if every application-level guard were deleted.
--
-- All datetimes are canonical ISO-8601 UTC strings written by the application
-- (new Date().toISOString()); they are never compared against SQLite's own
-- datetime('now'), whose different format breaks lexicographic ordering.
-- STRICT tables enforce column types; every column is NOT NULL because a
-- CHECK that evaluates to NULL silently passes.

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  venue        TEXT    NOT NULL,
  starts_at    TEXT    NOT NULL,
  capacity     INTEGER NOT NULL CHECK (capacity > 0),
  seats_booked INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT seats_within_capacity CHECK (seats_booked >= 0 AND seats_booked <= capacity)
) STRICT;

CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY,
  reference      TEXT    NOT NULL UNIQUE,
  event_id       INTEGER NOT NULL REFERENCES events(id),
  attendee_name  TEXT    NOT NULL,
  attendee_email TEXT    NOT NULL,
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  status         TEXT    NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at     TEXT    NOT NULL,
  cancelled_at   TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id);
