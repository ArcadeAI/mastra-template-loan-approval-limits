/**
 * Studio's thread memory (#36): the agent remembers earlier turns of a thread.
 *
 * Mastra Studio sends one message and a thread id per turn and expects the
 * agent to recall the rest. The web UI does not: the browser sends its own
 * bounded history with every request (`conversation.ts`), so the chat route's
 * agent has no memory at all and nothing here reaches it. Only `studio.ts`
 * builds one of these.
 *
 * ## Where it is stored
 *
 * `memory.db`, beside the app's three databases, unless `MEMORY_DB_PATH` says
 * otherwise (`memory-path.ts`). The file is created on the first turn Studio
 * runs, with no setup step, and it is gitignored by the same `*.db` line as
 * the others. `bun run reset` empties it, with or without `--hard`.
 *
 * It is `@mastra/libsql`'s memory domain on its own (`MemoryLibSQL`), not the
 * whole `LibSQLStore`: the file holds threads, messages, resources and
 * observational memory, and none of the workflow, trace or agent-registry
 * tables Studio would otherwise create. Studio runs under Node, which is why
 * this is libsql and not the `bun:sqlite` the app's three databases use.
 *
 * ## What it never holds
 *
 * A secret. Every message is run through `withholdSecrets` (`withhold.ts`, the
 * same three nets the chat applies to what it shows) at the storage boundary,
 * before it is written. Recall reads the store and Studio's thread view reads
 * the store, so neither can hand back a token a tool result once echoed. The
 * model still received that result in the turn it was returned: `/post` is the
 * control over what the model sees, and this is only about what is kept.
 *
 * ## What it never decides
 *
 * Who is acting. A recalled message is context, exactly as the browser's
 * history is: the persona is whoever holds Studio's gateway grant, and a
 * message claiming to be somebody else changes nothing about which bearer the
 * next tool call carries (`app-test/studio-memory.test.ts`).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { MastraDBMessage } from "@mastra/core/memory";
import { MastraCompositeStore } from "@mastra/core/storage";
import { MemoryLibSQL } from "@mastra/libsql";
import { Memory } from "@mastra/memory";

import { IN_MEMORY } from "./memory-path.ts";
import { withholdSecrets, type WithheldSet } from "./withhold.ts";

export { memoryDbPath } from "./memory-path.ts";

/** A message with its content withheld. Only `content`: the id, thread and dates are not tool output. */
function withheld<M extends { content?: unknown }>(message: M, secrets: WithheldSet): M {
  if (message.content === undefined || message.content === null) return message;
  return { ...message, content: withholdSecrets(message.content, secrets).value };
}

/**
 * The memory domain, withholding secrets on the way in.
 *
 * `saveMessages` and `updateMessages` are the two ways a message's content
 * reaches the file. The agent's own save (`Memory.saveMessages`) and the
 * message-history processor's both call the first; copying a thread copies
 * rows that were withheld when they were written.
 */
export class WithheldMemoryStorage extends MemoryLibSQL {
  readonly #secrets: () => WithheldSet;

  constructor(options: { url: string; secrets: () => WithheldSet }) {
    super({ url: options.url });
    this.#secrets = options.secrets;
  }

  override async saveMessages(args: { messages: MastraDBMessage[] }) {
    const secrets = this.#secrets();
    return super.saveMessages({ messages: args.messages.map((message) => withheld(message, secrets)) });
  }

  override async updateMessages(args: Parameters<MemoryLibSQL["updateMessages"]>[0]) {
    const secrets = this.#secrets();
    return super.updateMessages({ messages: args.messages.map((message) => withheld(message, secrets)) });
  }
}

/** A Mastra `Memory` over a store at `path`, and the path it was opened at. */
export interface ThreadMemory {
  path: string;
  memory: Memory;
}

/**
 * Thread memory over the file at `path`, created if it is not there.
 *
 * `secrets` is asked on every write rather than once, because what Studio holds
 * changes: a refreshed or re-authorized gateway grant is a new bearer.
 *
 * Mastra's defaults otherwise: the last ten messages of the thread, no semantic
 * recall (it would need an embedder and a vector store), no working memory and
 * no generated titles (either would be an extra model call per turn).
 */
export function threadMemory(options: { path: string; secrets: () => WithheldSet }): ThreadMemory {
  if (options.path !== IN_MEMORY) mkdirSync(dirname(options.path), { recursive: true });
  const url = options.path === IN_MEMORY ? IN_MEMORY : `file:${options.path}`;
  const storage = new MastraCompositeStore({
    id: "loan-operations-memory",
    domains: { memory: new WithheldMemoryStorage({ url, secrets: options.secrets }) },
  });
  return { path: options.path, memory: new Memory({ storage }) };
}
