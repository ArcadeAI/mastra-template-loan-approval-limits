/**
 * The handful of pages the identity routes render themselves.
 *
 * Plain HTML from a route handler rather than React, because every one of them
 * is reached by a *redirect from somebody else's server* — Arcade's, or the
 * IdP's — at a point where the thing that matters is that the browser is told
 * exactly what went wrong and what to do about it. `DESIGN.md`'s recurring
 * warning is a control that fails quietly; these are the screens that keep hop
 * 2 from being one. Nothing here fails silently and nothing here is a redirect
 * to a generic error.
 *
 * Every value interpolated into these pages is escaped. Two of them carry text
 * from another system verbatim — an OAuth `error_description`, an Arcade
 * refusal body — and a page that renders a counterparty's string unescaped is a
 * page that renders their markup.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One page, styled to match the app's own type without importing its CSS. */
export function page(title: string, body: string, status = 200, headers = new Headers()): Response {
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font:16px/1.6 system-ui,sans-serif;margin:4rem auto;max-width:36rem;padding:0 1.5rem">` +
      `<h1 style="font-size:1.5rem">${escapeHtml(title)}</h1>${body}</body>`,
    { status, headers },
  );
}

/** A block of text some other system produced, shown rather than summarised. */
export function verbatim(text: string): string {
  return `<pre style="white-space:pre-wrap;background:#f5f5f5;padding:0.75rem;border-radius:4px;font-size:0.875rem">${escapeHtml(
    text,
  )}</pre>`;
}

/** A 303, with whatever cookies the caller has already appended. */
export function redirect(location: string, headers = new Headers()): Response {
  headers.set("location", location);
  return new Response(null, { status: 303, headers });
}

/**
 * What `/health` would have said, said to whoever hit the route instead.
 *
 * A misconfigured variable is not a 500: it is an operational state with a
 * named cause, and the person looking at this screen is the person who can fix
 * it. Each problem is a whole sentence from `lib/config.ts`, not a variable
 * name, because one of them is not a name — a `SESSION_SECRET` that is set but
 * too short has to say why, or a human reads "SESSION_SECRET" and goes to look
 * at a field that is already filled in.
 */
export function notConfigured(what: string, problems: string[], headers = new Headers()): Response {
  return page(
    `${what} is not configured`,
    `<p>This deployment cannot do that yet:</p><ul>` +
      problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("") +
      `</ul><p><code>GET /health</code> reports which of <code>signin</code>, <code>gateway</code> and ` +
      `<code>verifier</code> this deployment has. See <code>apps/web/README.md</code> for where each value comes from.</p>`,
    503,
    headers,
  );
}
