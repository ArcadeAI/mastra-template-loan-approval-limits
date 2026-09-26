/**
 * `bun run reset` — the demo back to the seeded state, in seconds.
 *
 *     bun run reset          # between takes: the loan book and the control plane
 *     bun run reset --hard   # ...and the IdP, which signs every persona out
 *
 * Three databases, three modules of the one app — but **not on every run**:
 *
 *     control plane   POST /hooks/admin/reset   {"mode":"demo"} — the four
 *                                         policy tables from the fixture, and
 *                                         grants, approval requests and the
 *                                         audit log emptied (`apps/hooks`
 *                                         until #4)
 *     loan module     POST /bank/admin/reset   the loan book, LN-2291 unapproved
 *                                         (`apps/loan-app` until #5)
 *     identity        POST /identity/admin/reset   everyone's sessions,
 *                                         tokens and consents — `--hard` only
 *                                         (`apps/idp` until #6)
 *
 * **Neither scope deletes a user** (#32, #33). Somebody added with
 * `bun run users` keeps their `subjects` row through both, and their
 * identity account through `--hard`. Only the demo cast's subjects — the
 * fixture's addresses, where `bun run users seed-demo` put them — are put back
 * to the demo's roles and clearances; one that is not on disk is not added.
 * Each line of output names who was kept.
 *
 * All three at one address since #6: `APP_PUBLIC_HOST`. To reset a deployment
 * rather than this checkout's app, run the command with that deployment's
 * `APP_PUBLIC_HOST` and `RESET_TOKEN` in its environment.
 *
 * ## Why the IdP is not in the default run (#123)
 *
 * Because between takes it costs stage time and buys nothing.
 *
 * Resetting the IdP deletes every person, session, token and consent, so all
 * four personas are signed out. Each one then needs a cg-idp login **and** a
 * hop-2 authorization card plus a Continue on their first governed call —
 * measured live on 2026-09-19, where exactly that happened and cleanly
 * recovered. And the personas never change on stage: they come out of a
 * fixture, nothing in a take edits them, so re-seeding them puts back
 * something that was never disturbed.
 *
 * What a take *does* disturb is the loan book and the control plane, and those
 * are what the default run puts back.
 *
 * (#123 was filed for a worse story — a dead grant Arcade would present
 * forever without re-challenging. That turned out to be #100's replay
 * revocation killing a *fresh* authorization, fixed in bbfb162, and the hop-2
 * token is a one-hour credential with no refresh token anyway. The issue has
 * the measurements. Nothing here depends on it: a reset that signs four people
 * out mid-rehearsal is worth avoiding on its own.)
 *
 * ## Why `--hard` still exists
 *
 * Wiping the IdP is the only way to show signing in and authorizing from
 * clean, which is the whole point of #174's second button. There the sign-out
 * is not a cost to avoid; it is the state the demo wants. What `--hard` owes
 * the presenter is to **say** what it has just made them do again, which it
 * does in its own output.
 *
 * ## Why HTTP and not a shell
 *
 * Each service seeds from the fixture compiled into **its own running image**.
 * A `sqlite3` session in a shell on the host cannot promise that: on 2026-09-14,
 * on the stage demo's deployment, two of three manual reseeds were attached to a
 * rolled-back instance and wrote
 * the old rows back, so the next deploy failed closed again (#106). The
 * endpoint is served by the process that is actually answering requests, which
 * is the only thing that can make the promise.
 *
 * It also means this command needs no SSH, no shell on the host and no
 * `sqlite3`: just one bearer and one address.
 *
 * ## Two things this is not
 *
 * **A redeploy is not a reset.** All three databases sit on a persistent disk
 * and seed only when empty (#29), so a redeploy carries every stage edit and
 * every approval forward. This command is the only way back.
 *
 * **A reset is not a re-registration.** `idp.db` holds the OAuth client id and
 * secret that were typed into the Arcade dashboard by hand. Nothing here
 * rotates them — and rather than trust that, the idp's reset asserts it and
 * this command checks the answer against what `/health` said beforehand. If
 * they ever moved, OAuth would fail at the authorize step, which Arcade
 * evaluates *before* `/pre`: no hook, no audit row, a dark panel, and nothing
 * on any screen saying why.
 *
 * ## Addresses
 *
 * HOST-form, and read from the environment, never derived: a guessed hostname
 * is somebody else's deployment. The one variable is `APP_PUBLIC_HOST`, which
 * this checkout's `.env` already carries. Scheme is added here: `http` for
 * loopback, `https` for everything else.
 *
 * There is no `--target`. It chose between this checkout and the stage demo's
 * hosted deployment until #11, and it is refused by name rather than ignored:
 * a presenter who typed it expects some other environment to be reset, and
 * quietly resetting this one instead is the half-reset believed clean.
 */
import { assertPublicHost, PublicHostError } from "../lib/control-plane/public-host.ts";

/** sysexits: the environment is wrong, not the invocation. */
const EX_CONFIG = 78;

interface ServiceSpec {
  /** What the output calls it. */
  label: string;
  body?: unknown;
  /**
   * Its reset endpoint: `/hooks/admin/reset` for the control plane since #4,
   * which the app mounts under `/hooks`, `/bank/admin/reset` for the loan
   * module since #5, mounted under `/bank`, and `/identity/admin/reset` for
   * the identity module since #6, mounted under `/identity`.
   */
  resetPath: string;
}

/** The one address every module is reset at, since #6 made them one app. */
const APP_HOST = "APP_PUBLIC_HOST";

/**
 * Identity first when it runs at all. It is the only one whose failure means
 * "stop": a rotated OAuth client is a re-registration in a dashboard, and
 * there is no point resetting the other two into a demo that cannot authorize.
 */
const IDP: ServiceSpec = {
  label: "idp",
  resetPath: "/identity/admin/reset",
};

/**
 * Everything a reset between takes puts back. Neither of these holds a
 * credential Arcade is registered against, so neither can produce the dead
 * grant #123 is about.
 */
const BETWEEN_TAKES: ServiceSpec[] = [
  // `demo` explicitly, never the endpoint's own default: `policy` is the
  // conservative mode for a caller that did not say, and a rehearsal reset
  // that quietly left the audit log full is exactly the silent half-reset this
  // command exists to replace.
  {
    label: "hooks",
    body: { mode: "demo" },
    resetPath: "/hooks/admin/reset",
  },
  // The loan module, in the app since #5. Still labelled `loan-app`, because
  // that is what its reset answers as and what a presenter reads in this
  // output.
  {
    label: "loan-app",
    resetPath: "/bank/admin/reset",
  },
];

/**
 * The services this run will call, in order.
 *
 * Exported so a caller — `scripts/reset.ts --hard`, and #174's panel button
 * after it — asks this module which services a scope means rather than
 * keeping its own list that can drift out of agreement with this one.
 */
export function servicesFor(hard: boolean): ServiceSpec[] {
  return hard ? [IDP, ...BETWEEN_TAKES] : BETWEEN_TAKES;
}

/**
 * The sentence a soft run owes the presenter: what it deliberately did not do.
 *
 * Printed on every soft run rather than only when something looks wrong. A
 * reset that silently stopped covering a database is the half-reset believed
 * clean that this whole command exists to replace, and "I skipped it" is only
 * useful if it is said before anybody has a reason to ask.
 */
export const SOFT_SKIP_LINE =
  "idp      SKIPPED  people, sign-ins, tokens and consents left alone, so nobody has to log in " +
  "or authorize again between takes (#123). `--hard` resets it too.";

/**
 * And the sentence a hard run owes them, which is the other half of the same
 * fact. A presenter who has just signed all four personas out should read that
 * here, not discover it at the login page in front of an audience.
 *
 * It describes a recovery that **works**, and deliberately stops there. An
 * earlier draft of this told the presenter to go and revoke each grant in the
 * Arcade dashboard; live evidence on 2026-09-19 is that Arcade raises the
 * authorization card on its own and Continue clears it, so that instruction
 * would have sent someone to a dashboard to fix something that was not broken.
 */
export const HARD_SIGNOUT_NOTICE =
  "Everyone is signed out and every consent is gone — the demo cast and every user added by " +
  "`bun run users`, whose accounts and passwords are otherwise untouched. Each one now needs a " +
  "sign-in login, and their first governed tool call raises the hop-2 authorization card — " +
  "authorize, then Continue. That is the flow this reset exists to make demonstrable (#174); " +
  "budget the clicks before you are on stage.";

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[?::1\]?)(:\d+)?$/i;

export function originFor(host: string): string {
  return `${LOOPBACK.test(host) ? "http" : "https"}://${host}`;
}

export interface ResetOptions {
  /**
   * Reset `apps/idp` as well. Off by default — see the note at the top of this
   * file on why a between-takes reset must not touch identity.
   */
  hard?: boolean;
  env: Record<string, string | undefined>;
  /** Injected in tests; `fetch` in anger. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export interface ServiceOutcome {
  label: string;
  ok: boolean;
  line: string;
}

export interface ResetOutcome {
  ok: boolean;
  /** What this run was asked to cover. */
  hard: boolean;
  services: ServiceOutcome[];
}

/** A configuration problem: names the variable and where the value comes from. */
export class ResetConfigError extends Error {}

function requireToken(env: Record<string, string | undefined>): string {
  const token = env.RESET_TOKEN?.trim() ?? "";
  if (token.length > 0) return token;
  throw new ResetConfigError(
    "RESET_TOKEN is unset. It is the bearer all three modules require, it has no development " +
      "default, and without it each of them answers 404 on its admin/reset route. Generate one " +
      "with `openssl rand -hex 32`, set it on the app (which holds the control plane, the loan " +
      "module and the identity module since #6), and put the same value in .env.local here.",
  );
}

function requireHost(options: ResetOptions): string {
  const name = APP_HOST;
  const host = options.env[name]?.trim() ?? "";
  if (host.length === 0) {
    throw new ResetConfigError(
      `${name} is unset, so there is no address for the app. Set it to the host the app is ` +
        "served on, host part only and no scheme: the ngrok domain for this checkout, or the " +
        "deployment's own host. Never derive or guess it: a guessed hostname is somebody " +
        "else's deployment.",
    );
  }
  try {
    assertPublicHost(name, host);
  } catch (cause) {
    if (cause instanceof PublicHostError) throw new ResetConfigError(cause.message);
    throw cause;
  }
  return host;
}

/** `4 → 4`, or `918 → 0`, for every table the service reported. */
function deltas(before: Record<string, number>, after: Record<string, number>): string {
  return Object.keys(after)
    .map((table) => `${table} ${before[table] ?? 0}→${after[table] ?? 0}`)
    .join(", ");
}

interface IdpHealth {
  reset?: string;
  oauth?: { clients?: { key: string; client_id: string }[] };
}

/**
 * One service: POST, read the body, turn it into a line a presenter can read
 * at a glance.
 *
 * A non-2xx is reported with the status **and** the body, because the two
 * interesting failures are distinguishable only that way: a 404 means
 * `RESET_TOKEN` is unset on *that service* (the route does not exist), and a
 * 401 means this command holds a different value from the one it is set to.
 */
async function resetOne(
  spec: ServiceSpec,
  options: Required<Pick<ResetOptions, "fetch" | "timeoutMs">> & ResetOptions,
  token: string,
): Promise<ServiceOutcome> {
  const host = requireHost(options);
  const origin = originFor(host);
  const label = spec.label.padEnd(8);

  // What the idp's OAuth client ids were *before* anything ran, so the
  // assertion below is against an independent reading rather than against the
  // same response that claims nothing moved.
  let clientsBefore: { key: string; client_id: string }[] | null = null;
  if (spec.label === "idp") {
    const health = (await readJson(`${origin}/identity/health`, options)) as IdpHealth | null;
    clientsBefore = health?.oauth?.clients ?? null;
  }

  let response: Response;
  try {
    response = await options.fetch(`${origin}${spec.resetPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    return { label: spec.label, ok: false, line: `${label} UNREACHABLE  ${origin} — ${String(cause)}` };
  }

  const text = await response.text();
  if (!response.ok) {
    const hint =
      response.status === 404
        ? " — RESET_TOKEN is unset on that service, so the route does not exist"
        : response.status === 401
          ? " — that service has a different RESET_TOKEN from this one"
          : "";
    return {
      label: spec.label,
      ok: false,
      line: `${label} REFUSED  HTTP ${response.status}${hint}: ${text.slice(0, 400)}`,
    };
  }

  const body = JSON.parse(text) as Record<string, unknown>;

  if (spec.label === "idp") {
    const after = (body.clients ?? []) as { key: string; client_id: string }[];
    const moved = rotations(clientsBefore, after);
    if (moved.length > 0) {
      return {
        label: spec.label,
        ok: false,
        line:
          `${label} OAUTH CLIENT ROTATED  ${moved.join(", ")} — the Arcade app-identity provider ` +
          "registration is now stale and must be re-registered by hand. Authorization will fail " +
          "before any hook runs, so nothing on the panel will say why.",
      };
    }
    const people = body.people as { before: number; after: number };
    const kept = (body.kept ?? []) as string[];
    return {
      label: spec.label,
      ok: true,
      line:
        `${label} OK  everyone signed out; nobody deleted, ${kept.length} account${kept.length === 1 ? "" : "s"} kept ` +
        `with the password each already had` +
        (kept.length === 0 ? "" : ` (${kept.join(", ")})`) +
        `; people ${people.before}→${people.after}, ` +
        `OAuth client${after.length > 1 ? "s" : ""} ${after.map((each) => each.client_id).join(", ")} unchanged`,
    };
  }

  if (spec.label === "hooks") {
    const counts = body.counts as {
      before: Record<string, number>;
      after: Record<string, number>;
    };
    const kept = ((body.kept as { subjects?: string[] } | undefined)?.subjects ?? []) as string[];
    const demoCast = ((body.demo_cast as { subjects?: string[] } | undefined)?.subjects ?? []) as string[];
    return {
      label: spec.label,
      ok: true,
      line:
        `${label} OK  ${String(body.mode)} at revision ${String(body.revision)} — ${deltas(counts.before, counts.after)}` +
        "; " +
        (demoCast.length === 0
          ? "no demo cast on disk, none added"
          : `demo cast's subjects put back to the demo's roles and clearances (${demoCast.join(", ")})`) +
        `; ${kept.length} added by \`bun run users\` kept` +
        (kept.length === 0 ? "" : ` (${kept.join(", ")})`),
    };
  }

  const counts = body.counts as {
    before: Record<string, number>;
    after: Record<string, number>;
  };
  return {
    label: spec.label,
    ok: true,
    line: `${label} OK  ${deltas(counts.before, counts.after)}`,
  };
}

/**
 * Client ids that moved between two readings.
 *
 * A reading that could not be taken at all — `/health` unreachable or shaped
 * differently — is not evidence that nothing moved, so it yields no rotations
 * here and the service's own assertion is what stands. Saying otherwise would
 * be this command claiming to have checked something it did not.
 */
function rotations(
  before: { key: string; client_id: string }[] | null,
  after: { key: string; client_id: string }[],
): string[] {
  if (before === null) return [];
  return after.flatMap((now) => {
    const was = before.find((candidate) => candidate.key === now.key);
    return was === undefined || was.client_id === now.client_id
      ? []
      : [`"${now.key}" ${was.client_id} -> ${now.client_id}`];
  });
}

async function readJson(url: string, options: ResetOptions & { fetch: typeof fetch; timeoutMs: number }) {
  try {
    const response = await options.fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * All three, in order, one line each. Exported so the test drives exactly what
 * the command does rather than a re-implementation of it.
 *
 * It does **not** stop at the first failure. A presenter between takes wants
 * to know everything that is wrong in one run, not to discover the second
 * problem after fixing the first — and the two databases downstream of a
 * broken idp are still worth putting back.
 */
export async function runReset(options: ResetOptions): Promise<ResetOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const hard = options.hard ?? false;
  const resolved = {
    ...options,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? 30_000,
  };
  const token = requireToken(options.env);
  const specs = servicesFor(hard);

  // Only the addresses this run will actually use. A soft run that demanded
  // IDENTITY_HOST would refuse to put the loan book back because of a
  // variable it was never going to read.
  log(
    `[reset] ${APP_HOST} ${requireHost(resolved)}, scope ${hard ? "hard (includes the IdP)" : "between-takes"} — ` +
      specs.map((spec) => spec.label).join(", "),
  );

  const started = performance.now();
  const services: ServiceOutcome[] = [];
  for (const spec of specs) {
    const outcome = await resetOne(spec, resolved, token);
    log(`[reset] ${outcome.line}`);
    services.push(outcome);
  }
  if (!hard) log(`[reset] ${SOFT_SKIP_LINE}`);

  const ok = services.every((service) => service.ok);
  const ms = Math.round(performance.now() - started);
  log(
    ok
      ? `[reset] done in ${ms}ms — ${specs.length} services back to the seeded state. A redeploy is not a reset; a reset is not a re-registration.`
      : `[reset] FAILED in ${ms}ms — ${services.filter((service) => !service.ok).map((service) => service.label).join(", ")}. The demo is NOT in a known state.`,
  );
  // After the verdict, not before it: the grant warning is the consequence of
  // a reset that worked, and printing it above a FAILED line would read as
  // part of the failure.
  if (hard && services.find((service) => service.label === "idp")?.ok === true) {
    log(`[reset] ${HARD_SIGNOUT_NOTICE}`);
  }
  return { ok, hard, services };
}

/** `--target` is gone, and refused rather than ignored (see "Addresses" above). */
export function refuseTarget(argv: string[]): void {
  if (!argv.some((arg) => arg === "--target" || arg.startsWith("--target="))) return;
  throw new ResetConfigError(
    `--target is not an option any more. The reset runs against ${APP_HOST}; to reset a ` +
      `deployment, run it with that deployment's ${APP_HOST} and RESET_TOKEN in the environment.`,
  );
}

/**
 * `--hard`, and nothing that merely looks like it.
 *
 * A misspelling is refused rather than read as "soft", because the two
 * spellings mean opposite things about identity and the quiet reading is the
 * one that ruins a rehearsal: `--hard-reset` silently leaving the IdP alone is
 * a presenter who thinks they have a clean auth flow to demonstrate and does
 * not.
 */
export function parseHard(argv: string[]): boolean {
  const nearly = argv.find(
    (arg) => arg !== "--hard" && /^--?h(ard)?/i.test(arg),
  );
  if (nearly !== undefined) {
    throw new ResetConfigError(
      `${nearly} is not an option. The flag that also resets apps/idp is exactly \`--hard\`; ` +
        "without it the IdP is left alone, so nobody is signed out and nobody has to authorize " +
        "again (#123).",
    );
  }
  return argv.includes("--hard");
}

if (import.meta.main) {
  try {
    const argv = Bun.argv.slice(2);
    refuseTarget(argv);
    const outcome = await runReset({
      hard: parseHard(argv),
      env: process.env,
    });
    process.exit(outcome.ok ? 0 : 1);
  } catch (cause) {
    if (!(cause instanceof ResetConfigError)) throw cause;
    console.error(`[reset] ${cause.message}`);
    process.exit(EX_CONFIG);
  }
}
