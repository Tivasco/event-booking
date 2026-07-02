import { createEvents } from './domain/events.js';
import { errors, DomainError } from './errors.js';
import { errorPage, html } from './views/html.js';
import { availabilitySection, eventDetailPage, eventListPage } from './views/events.js';

const isHtmx = (req) => req.get('HX-Request') === 'true';

export function registerRoutes(app, db, options = {}) {
  const events = createEvents(db, options);

  app.get('/', (req, res) => {
    res.send(String(eventListPage(events.listUpcoming())));
  });

  app.get('/events/:id', (req, res) => {
    res.send(String(eventDetailPage(mustFindEvent(events, req.params.id))));
  });

  app.get('/events/:id/availability', (req, res) => {
    res.send(String(availabilitySection(mustFindEvent(events, req.params.id))));
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
