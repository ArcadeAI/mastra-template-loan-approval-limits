# Vendored upstream schema

`logic-extensions-http-1.0.schema.yaml` is a byte-for-byte copy of

    ArcadeAI/schemas · logic_extensions/http/1.0/schema.yaml

pinned at commit [`eee60f3`](https://github.com/ArcadeAI/schemas/blob/eee60f38c6e5be8995121258a7519d2fc21b462a/logic_extensions/http/1.0/schema.yaml)
(committed 2026-03-11), spec version `1.1.1-beta`.

It is vendored rather than fetched at generation time for three reasons: generation stays
repeatable offline and in CI, the diff of an upstream change is visible in review rather
than appearing silently in generated output, and the pin is what makes
`bun run generate:check` a meaningful assertion.

## Refreshing

    bun run --cwd packages/policy-schema fetch   # pull upstream main, rewrite this file
    bun run --cwd packages/policy-schema generate

Commit the vendored spec and the regenerated `src/generated/hook-contract.ts` together,
and update the pin above. Review the YAML diff: this is Arcade's contract changing, which
usually means our hook handlers have to change too.
