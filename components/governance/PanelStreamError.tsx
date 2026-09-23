/**
 * What the panel shows when it has not been told which stream to watch.
 *
 * This is the whole point of #81. The panel used to fall back to the built-in
 * replay in exactly this case, and a replay is indistinguishable from a working
 * control plane to everyone in the room — so a deployment that could not reach
 * its hook server looked like one whose every decision was being observed. The
 * error state is the refusal: no lanes, no cards, no socket opened, and the
 * name of the variable that is missing, large enough to read off a projector.
 *
 * It takes the place of the panel rather than sitting above it, deliberately.
 * A banner over a running replay would still be a running replay, and whoever
 * is talking over it would still be pointing at rows that mean nothing.
 *
 * `--deny` red, which this design system reserves for a decision. A panel that
 * cannot show the control plane is a refusal, and this state never renders
 * beside a card, so there is nothing here for it to be confused with.
 */
export interface PanelStreamErrorProps {
  /** The sentence from `resolvePanelStream`, naming the variable at fault. */
  readonly problem: string;
}

export function PanelStreamError({ problem }: PanelStreamErrorProps) {
  return (
    <div className="cg-panel">
      <header className="cg-header">
        <h2 className="cg-title">Control plane</h2>
        <div className="cg-connection" data-status="reconnecting">
          <span className="cg-mode" data-mode="unconfigured">
            NO STREAM
          </span>
        </div>
      </header>

      <section className="cg-stream-error" role="alert">
        <h3 className="cg-stream-error-title">This panel is not watching anything</h3>
        <p className="cg-stream-error-problem">{problem}</p>
        <p className="cg-stream-error-note">
          Nothing is being replayed in its place. A demo replay shown here would be
          indistinguishable from the live control plane, which is the one thing this surface
          must never be. <code>GET /health</code> answers{" "}
          <code>&quot;panel_stream&quot;: &quot;unconfigured&quot;</code> and{" "}
          <code>&quot;status&quot;: &quot;degraded&quot;</code> for the same reason.
        </p>
        <p className="cg-stream-error-note">
          To watch the built-in replay on purpose, and have the panel say so: set{" "}
          <code>GOVERNANCE_STREAM=fixture</code>, or open <code>/panel?fixture=1</code>.
        </p>
      </section>
    </div>
  );
}
