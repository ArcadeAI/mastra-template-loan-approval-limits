/**
 * "You are on the wrong host", in front of the application (#9).
 *
 * Rendered by `app/page.tsx` when `lib/origin.ts` finds `APP_PUBLIC_HOST` set
 * and the page served under another host. The sessions and the custom verifier
 * live on the public host only, so on any other host sign-in and Arcade's
 * authorization never stick, and nothing else on the page would say why. Amber
 * rather than the configuration banner's red: the deployment is fine, the
 * browser is in the wrong place.
 */
import type { OriginMismatch } from "../../lib/origin.ts";

export function OriginBanner({ mismatch }: { mismatch: OriginMismatch | null }) {
  if (mismatch === null) return null;

  return (
    <section
      role="alert"
      data-origin-banner=""
      style={{
        border: "2px solid #9a6700",
        borderLeftWidth: "8px",
        borderRadius: "6px",
        background: "#fff8e1",
        color: "#4d3300",
        padding: "1rem 1.25rem",
        margin: "0 0 0.5rem",
      }}
    >
      <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Open this app at {mismatch.expected}</h2>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        This page is open at <code>{mismatch.current}</code>. Sign-in, sessions and the Arcade verifier
        live on <code>{mismatch.expected}</code> (<code>APP_PUBLIC_HOST</code>) only, so signing in here
        will not stick. <a href={mismatch.expected}>Open {mismatch.expected}</a>.
      </p>
    </section>
  );
}
