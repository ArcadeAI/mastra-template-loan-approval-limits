/**
 * The Arcade auth provider id for hop 2 is fixed, `app-identity`, and a rename
 * is one constant per language (#6, Q4).
 *
 * `tools/loan` names it in `OAuth2(id=IDP_PROVIDER_ID)`, which Arcade reads at
 * import, so it is not configurable. The identity provider names it in the
 * messages that tell a human which Arcade registration went stale
 * (`ARCADE_PROVIDER_ID`). If the two disagreed, the boot line after a rotation
 * would send somebody to the wrong provider in the dashboard. Since #9
 * `bun run setup-arcade` registers the provider under it, and that has to
 * match too. `.env.example` no longer names it: nothing reads the variable.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ARCADE_PROVIDER_ID } from "../../lib/identity/provider/client.ts";
import { PROVIDER_ID, providerBody } from "../../scripts/setup-arcade/arcade.ts";

const REPO = join(import.meta.dir, "..", "..");

test("tools/loan, the identity provider and setup-arcade name the same provider id", () => {
  const python = readFileSync(join(REPO, "tools", "loan", "loan", "__init__.py"), "utf8");
  const declared = /^IDP_PROVIDER_ID = "([^"]+)"$/m.exec(python)?.[1];
  expect(declared).toBe("app-identity");
  expect(ARCADE_PROVIDER_ID).toBe(declared!);
  // And the toolkit uses the constant rather than a second literal.
  expect(python).toContain("OAuth2(id=IDP_PROVIDER_ID");

  const registered = providerBody({
    host: "h.example",
    origin: "https://h.example",
    arcadeClientId: "c",
    arcadeClientSecret: "s",
    approvalsStoreToken: "a",
  });
  expect(PROVIDER_ID).toBe(declared!);
  expect(registered.id).toBe(declared!);
});
