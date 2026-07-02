// Rendering primitives. The whole view layer is template-literal functions:
// at this size a template engine is a dependency without payoff, and safety
// comes from one rule — every interpolated value is HTML-escaped unless it is
// itself an Html instance (a nested template) or explicitly raw().

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

class Html {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export const raw = (value) => new Html(String(value));

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += renderValue(value) + strings[i + 1];
  });
  return new Html(out);
}

function renderValue(value) {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value == null || value === false) return ''; // enables `${cond && html`…`}`
  return esc(value);
}

// htmx swaps 2xx responses only by default; this app returns honest 4xx
// statuses for business failures (409 sold out, 422 validation) and still
// needs their bodies rendered. The config REPLACES the default list wholesale
// and first match wins, so the business codes come before the [45].. rule.
// Genuine 5xx stays unswapped: a crash must never eat the form.
const HTMX_CONFIG = JSON.stringify({
  responseHandling: [
    { code: '204', swap: false },
    { code: '[23]..', swap: true },
    { code: '404', swap: true, error: false },
    { code: '409', swap: true, error: false },
    { code: '422', swap: true, error: false },
    { code: '[45]..', swap: false, error: true },
    { code: '...', swap: true },
  ],
});

export function page({ title, body }) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="htmx-config" content="${HTMX_CONFIG}" />
    <title>${title} · Seatwise</title>
    <link rel="stylesheet" href="/styles.css" />
    <script src="/htmx.min.js" defer></script>
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">Seatwise</a>
    </header>
    <main>${body}</main>
  </body>
</html>`;
}

export function errorPage({ title, message }) {
  return page({
    title,
    body: html`
      <section class="notice-page">
        <h1>${title}</h1>
        <p>${message}</p>
        <p><a href="/">Back to all events</a></p>
      </section>
    `,
  });
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

// Times are stored and shown in UTC — labelled, so the page never implies a
// local time it doesn't know.
export function formatDate(iso) {
  return `${DATE_FORMAT.format(new Date(iso))} UTC`;
}
