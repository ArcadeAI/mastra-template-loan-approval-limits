# Cross-language contract fixtures

JSON test vectors consumed by more than one language, so that two
implementations of one rule are *checked* against the same rows rather than
argued to agree.

Distinct from the package's two other sources: `vendor/` is Arcade's upstream
schema, pinned; `src/` is our TypeScript. These files are neither — they are
data, and the point is that nothing here can only be read by TypeScript.

| file | rule | read by |
|---|---|---|
| `approver-routing-cases.json` | minimum-sufficient-clearance approver routing (#9) | `packages/governance-core/test/approver-router.test.ts`, `tools/approvals/tests/test_routing.py` |

## Reading one

Every case names its subjects by short key into the file's own `subjects` map,
so a roster is a list of keys and the expected result is a list of `user_id`s.
Amounts that JSON cannot hold — `NaN`, `Infinity`, `-Infinity` — appear as
those strings under `invalid_amounts` and each reader maps them to its own
non-finite value.

Adding a row is the cheap way to pin a behaviour in both languages at once.
Removing one is not: a row deleted here silently stops being checked on both
sides. Both test files assert the case count they loaded is non-zero, so an
empty or unreadable file fails loudly instead of passing vacuously.
