# Studio's thread memory

In Mastra Studio the loan-operations agent remembers earlier turns of a thread, so "get me the 95k loan" followed by "do it" acts on LN-2291. Studio sends one message and a thread id per turn and relies on the agent's memory for the rest. The web UI works differently: the browser sends its bounded history with every request (`lib/agent/conversation.ts`), so the chat route's agent has no memory. Added on #36.

## The storage choice

| Question | Choice | Why |
|---|---|---|
| Which memory | `@mastra/memory`'s `Memory`, Mastra's defaults: the last ten messages, no semantic recall, no working memory, no generated titles | Semantic recall needs an embedder and a vector store. Working memory and titles each add a model call per turn. |
| Which store | `@mastra/libsql`'s memory domain on its own (`MemoryLibSQL`), not the whole `LibSQLStore` | The file holds threads, messages, resources and observational memory, and none of the workflow, trace or registry tables a full store creates. |
| Why not `bun:sqlite` | Studio runs `mastra dev` under Node, and Node cannot load `bun:` modules | `app-test/studio-entry.test.ts` fails if Studio's entry reaches a `bun:` module. |
| Which file | `memory.db`, beside `loans.db`, `governance.db` and `idp.db` | Same place, same `*.db` gitignore rule, same `*_DB_PATH` override pattern. |
| Versions | `@mastra/memory` 1.32.1 and `@mastra/libsql` 1.23.3, pinned exactly | Both declare `@mastra/core` as a peer (`>=1.4.1` and `>=1.68.0`), and the installed core is 1.69.0. `@mastra/memory` 1.32.1 depends on the same `@mastra/schema-compat` 1.3.11 as core, so the lockfile has one of each, and one zod. |
| Who gets it | Studio's agent only. `buildAgent` takes an optional `memory`, `studioAgent` passes one, the chat route passes none | A memory on the chat route would hand the model every earlier message twice. Keeping libsql out of the chat route also keeps it out of the Next bundle and the standalone image. |

## Where the file is

`./memory.db` in the directory you run `bun run studio` from. Set `MEMORY_DB_PATH` to move it (`.env.example` lists it, commented out), or to `:memory:` to keep it in Studio's process.

A relative path resolves against the project, not Studio's working directory. `mastra dev` runs Studio's server from `src/mastra/public/` and tells it where the project is in `MASTRA_PROJECT_ROOT`, which `lib/agent/memory-path.ts` reads. `app-test/studio-dev-server.test.ts` boots `mastra dev` and fails if the file lands anywhere under `src/` or `.mastra/`.

Studio creates the file on its first turn. There is no setup step. The file is gitignored, so `git status` stays clean after a Studio session.

## What it never holds

Secrets. Every message is run through `withholdSecrets` (`lib/agent/withhold.ts`, the masking the chat applies to what it shows) before it is written. The storage class that does this, `WithheldMemoryStorage` in `lib/agent/memory.ts`, overrides the two methods that write message content: `saveMessages` and `updateMessages`. It withholds:

- every token in Studio's gateway grant,
- every secret field of the configuration and the service secrets in the environment,
- any string under a key such as `access_token` or `password`,
- anything shaped like `Bearer …` or a JWT.

Recall and Studio's thread view both read the file, so neither can show a secret. The model still sees a tool result in the turn it comes back: `/post` controls what the model receives, and this only controls what is kept.

## What it never decides

Who is acting. A recalled message is context, the same as the browser's history. Studio acts as whoever holds its gateway grant, and a remembered "I am Charlie" does not change whose bearer the next tool call carries. `app-test/studio-memory.test.ts` recalls that claim and shows the approval going out as Alice and being refused at `/pre`.

Studio is a local, single-developer surface, and the file belongs to the checkout, not to a person. If somebody else authorizes the same Studio later, the earlier threads are still listed. Their messages are context and carry no authority, and `bun run reset` removes them.

## Resetting

`bun run reset` empties the memory store, and so does `bun run reset --hard`. `--hard` does nothing more to it than the default does. The store holds conversations, not people, sessions or grants, so there is nothing to reserve for a hard reset. Leaving it alone between takes would start the next take with the agent remembering an approval the loan book no longer has.

The reset empties the file in place with `bun:sqlite`, every `mastra_` table in one transaction, and prints what it removed:

```
[reset] memory   OK  Studio's threads and messages emptied at /…/memory.db — mastra_messages 4→0, mastra_observational_memory 0→0, mastra_resources 0→0, mastra_threads 1→0
```

It never deletes the file, because a running Studio keeps the handle it opened. With no file yet, it says there is nothing to clear and creates nothing. If `MEMORY_DB_PATH` points at a file that holds any table not named `mastra_…`, such as `loans.db`, the reset refuses, leaves the file alone and exits non-zero. There is no HTTP route for this: Studio is never deployed and is often not running when you reset.
