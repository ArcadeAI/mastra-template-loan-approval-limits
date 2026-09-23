/**
 * Reading and comparing values inside a call's inputs. Internal to the
 * package — the PolicyEngine and the GrantChecker both do it and must do it
 * identically, and a second copy of either function is a second set of
 * semantics waiting to drift.
 *
 * Not re-exported from `./index.ts`: these are how the modules compare, not
 * part of the governance vocabulary.
 */

/**
 * The value at a dot path, or `undefined` if any segment is missing or the
 * path runs into a non-object. `"quantity"` and `"applicant.id"` are both
 * paths; a one-segment path is just a key lookup.
 */
export function readPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Structural equality over JSON-shaped values.
 *
 * Deliberately not `JSON.stringify` equality: that makes `{ a: 1, b: 2 }` and
 * `{ b: 2, a: 1 }` unequal, and key order in a tool call's arguments is not
 * something a caller controls or should be judged on.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
