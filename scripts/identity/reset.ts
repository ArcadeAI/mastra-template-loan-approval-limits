/**
 * Back to a clean rehearsal state: every session, token and consent is
 * dropped, so everybody is signed out, and every account is kept with the
 * password it already had (#33). **The OAuth client is not touched**, so the
 * credentials registered in the Arcade dashboard keep working. See
 * `lib/identity/provider/reset.ts` for why that is asserted rather than assumed.
 *
 *   bun run identity:reset
 *
 * This is the shell-on-the-service path. `bun run reset` at the repo root does
 * the same work through `POST /admin/reset`, which is the one to reach for
 * when there is no shell — and the only one that reaches the running image
 * rather than whichever instance a shell attached to.
 */
import { createAuth } from "../../lib/identity/provider/auth.ts";
import { readConfig } from "../../lib/identity/provider/config.ts";
import { openPeople } from "../../lib/identity/provider/db.ts";
import { OAuthClientRotatedError, resetSummary, runIdpReset } from "../../lib/identity/provider/reset.ts";

const config = readConfig();
const db = await openPeople(config.dbPath);
const auth = createAuth({ db, baseURL: config.baseURL, secret: config.secret });

try {
  const result = await runIdpReset({
    db,
    auth,
    clients: config.clients,
    secret: config.secret,
  });
  console.log(`[idp] ${resetSummary(config.dbPath, result)}`);
} catch (cause) {
  // Should be unreachable — `resetPeople` never touches `oauthClient` — but if
  // it ever is, the Arcade registration is now stale and someone must know.
  if (!(cause instanceof OAuthClientRotatedError)) throw cause;
  console.error(`[idp] ${cause.message}`);
  db.close();
  process.exit(1);
}

db.close();
