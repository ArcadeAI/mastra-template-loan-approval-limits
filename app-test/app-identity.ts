/**
 * The environment a real app needs to be its own identity provider, for a test
 * that boots Next (#6).
 *
 * Until #6 those tests pointed the app at the identity harness's `apps/idp` on
 * a port of its own, with `IDP_ISSUER`. The provider is part of the app now,
 * on the app's own port, and its issuer is `APP_PUBLIC_HOST`, so each booted
 * app gets a throwaway `idp.db` of its own, and client C is minted in it
 * before Next starts: the app reads `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET`
 * from its environment, and the secret is stored hashed and readable exactly
 * once (#70). It is minted the way a developer mints it, by running
 * `bun run oauth-client --client web --rotate` against the same database.
 *
 * `BETTER_AUTH_SECRET` is freshly random per call, never committed, and gone
 * with the directory.
 *
 * The demo cast goes into the same `idp.db` before Next starts (#33): the app
 * seeds nobody at first boot, and these tests sign in as the cast
 * (`demo-cast.ts`), so they are written the way `bun run users seed-demo`
 * writes them.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";
import { seedDemoIdentity } from "./demo-cast.ts";

const REPO_ROOT = join(import.meta.dir, "..");

export interface AppIdentity {
  /** Spread into the booted app's environment. */
  env: Record<string, string>;
  clientId: string;
  clientSecret: string;
}

export async function appIdentityEnv(origin: string, dir: string): Promise<AppIdentity> {
  mkdirSync(dir, { recursive: true });
  const base: Record<string, string> = {
    APP_PUBLIC_HOST: new URL(origin).host,
    IDP_DB_PATH: join(dir, "idp.db"),
    BETTER_AUTH_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
    IDP_OAUTH_CLIENTS: "web",
    IDP_OAUTH_REDIRECT_URIS_WEB: `${origin}/api/auth/callback`,
  };

  // An allowlisted environment (`child-env.ts`): a developer's own IDP_* and
  // host values are not passed through, because these tests are about the
  // throwaway database, as the identity harness's are.
  const rotate = spawnChild(
    ["bun", join(REPO_ROOT, "scripts", "identity", "oauth-client.ts"), "--json", "--client", "web", "--rotate"],
    { env: childEnv({ ...base, NODE_ENV: "test" }), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(rotate.stdout).text(),
    new Response(rotate.stderr).text(),
    rotate.exited,
  ]);
  if (code !== 0) throw new Error(`oauth-client --client web --rotate exited ${code}: ${err}`);
  const printed = JSON.parse(out) as {
    clients: Array<{ key: string; client_id: string; client_secret: string | null }>;
  };
  const web = printed.clients.find((each) => each.key === "web");
  if (!web?.client_secret) throw new Error(`no readable secret for client C in:\n${out}`);

  await seedDemoIdentity(base.IDP_DB_PATH!);

  return {
    env: { ...base, IDP_CLIENT_ID: web.client_id, IDP_CLIENT_SECRET: web.client_secret },
    clientId: web.client_id,
    clientSecret: web.client_secret,
  };
}
