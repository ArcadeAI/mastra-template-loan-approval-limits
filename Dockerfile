# Render does not detect Bun, so this service declares its runtime explicitly.
# Build context is the repo root — Bun workspaces need the root manifest and
# lockfile to link `packages/*`, and since #3 the root manifest is this app's.
#
# Built with Bun (for workspace linking) and served on Bun too since #4: the
# control plane (#4), the loan module (#5) and the identity module (#6) are
# modules of the app and open governance.db, loans.db and idp.db with
# `bun:sqlite`, which Node cannot load. Until #4 the runner was node:22-alpine.

FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
# --frozen-lockfile resolves the whole workspace, so every member's manifest
# has to be present even though only the root app gets built here.
# The loan module (#5) and the identity provider (#6) are workspace members
# for their manifests' `cg.governed` and `cg.external` flags, and the
# provider's declares Better Auth; their source arrives with `lib` below.
COPY lib/loans/package.json ./lib/loans/
COPY lib/identity/provider/package.json ./lib/identity/provider/
COPY packages ./packages

RUN bun install --frozen-lockfile

# The app's own tree, and nothing else at the root: `scripts/`, `test/` and
# `app-test/` have no business in the image.
COPY next.config.ts instrumentation.ts tsconfig.json tsconfig.build.json ./
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY public ./public

ENV NEXT_TELEMETRY_DISABLED=1
RUN bun --bun run next build

FROM oven/bun:1.3.14-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# `output: "standalone"` with `outputFileTracingRoot` at the repo root emits a
# self-contained tree that mirrors the monorepo layout. The app is the root, so
# `server.js` sits at the top of it.
#
# `public/` is inside that tree rather than a third COPY here: next.config.ts
# traces it onto `/`, so the tree this line copies is already the whole served
# artifact and `app-test/public-assets.test.ts` can boot it without Docker. See
# the `public/**/*` note in next.config.ts for why (#177). `.next/static`
# cannot go the same way — it is build output, not a source file tracing can
# include — so it stays a COPY.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 8080
CMD ["bun", "server.js"]
