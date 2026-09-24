/**
 * The Arcade auth provider id for hop 2 is fixed, `app-identity`, and a rename
 * is one constant per language (#6, Q4).
 *
 * `tools/loan` names it in `OAuth2(id=IDP_PROVIDER_ID)`, which Arcade reads at
 * import, so it is not configurable. The identity provider names it in the
 * messages that tell a human which Arcade registration went stale
 * (`ARCADE_PROVIDER_ID`). If the two disagreed, the boot line after a rotation
 * would send somebody to the wrong provider in the dashboard. `.env.example`
 * documents it for the reader, and that has to match too.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ARCADE_PROVIDER_ID } from "../../lib/identity/provider/client.ts";

const REPO = join(import.meta.dir, "..", "..");

test("tools/loan, the identity provider and .env.example name the same provider id", () => {
  const python = readFileSync(join(REPO, "tools", "loan", "loan", "__init__.py"), "utf8");
  const declared = /^IDP_PROVIDER_ID = "([^"]+)"$/m.exec(python)?.[1];
  expect(declared).toBe("app-identity");
  expect(ARCADE_PROVIDER_ID).toBe(declared!);
  // And the toolkit uses the constant rather than a second literal.
  expect(python).toContain("OAuth2(id=IDP_PROVIDER_ID");

  const example = readFileSync(join(REPO, ".env.example"), "utf8");
  expect(/^ARCADE_IDP_PROVIDER_ID=(.*)$/m.exec(example)?.[1]).toBe(declared!);
});
