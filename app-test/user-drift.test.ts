/**
 * `user_drift` (#33): who can sign in against who the hooks know.
 *
 * Nothing seeds either database since #33, and `bun run users` writes both
 * halves of a person or neither, so the two only disagree when somebody deletes
 * one half by hand or recreates one disk without the other. Both directions fail
 * silently — denied at every hook, or routed an approval they can never sign in
 * to decide — so `/health` names each address. Over the wire, against the real
 * app, in `test/reset-real-users.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import { compareUsers, userDriftWarning } from "../lib/user-drift.ts";

describe("compareUsers", () => {
  test("the same people on both sides is no drift, whatever the case or order", () => {
    expect(compareUsers(["Alice@Bank.Example", "bob@bank.example"], ["bob@bank.example", "alice@bank.example"])).toBeNull();
  });

  test("nobody on either side is no drift: a fresh start agrees with itself", () => {
    expect(compareUsers([], [])).toBeNull();
  });

  test("somebody who can sign in with no subject is named, by address", () => {
    expect(compareUsers(["alice@bank.example", "charlie@bank.example"], ["alice@bank.example"])).toEqual({
      ids: ["identity-without-subject:charlie@bank.example"],
      identity_without_subject: ["charlie@bank.example"],
      subject_without_identity: [],
    });
  });

  test("a subject nobody can sign in as is named, by address", () => {
    expect(compareUsers(["alice@bank.example"], ["alice@bank.example", "charlie@bank.example"])).toEqual({
      ids: ["subject-without-identity:charlie@bank.example"],
      identity_without_subject: [],
      subject_without_identity: ["charlie@bank.example"],
    });
  });

  test("both directions at once are both named, sorted", () => {
    const drift = compareUsers(["zed@x.test", "amy@x.test", "both@x.test"], ["both@x.test", "yan@x.test", "bea@x.test"]);
    expect(drift?.identity_without_subject).toEqual(["amy@x.test", "zed@x.test"]);
    expect(drift?.subject_without_identity).toEqual(["bea@x.test", "yan@x.test"]);
    expect(drift?.ids).toEqual([
      "identity-without-subject:amy@x.test",
      "identity-without-subject:zed@x.test",
      "subject-without-identity:bea@x.test",
      "subject-without-identity:yan@x.test",
    ]);
  });
});

describe("userDriftWarning", () => {
  test("says what each half cannot do, names every address, and the command that fixes it", () => {
    const warning = userDriftWarning(compareUsers(["alice@bank.example"], ["charlie@bank.example"])!);
    expect(warning).toContain("alice@bank.example can sign in but has no subject in governance.db, so every hook denies them");
    expect(warning).toContain("charlie@bank.example has a subject but no identity in idp.db");
    expect(warning).toContain("approval routing can still pick them");
    expect(warning).toContain("bun run users list");
  });
});
