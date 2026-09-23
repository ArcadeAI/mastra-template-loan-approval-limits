/**
 * A stand-in for Arcade's tool-execution endpoint, runnable by a person.
 *
 * **This is not the product.** It is a development fixture, in the same
 * category as the persona switcher and `apps/idp`: it exists so the two beats
 * of the approval flow can be driven on a laptop, and a forker can delete it.
 * Nothing under `app/` imports it, and it is never in the deployed image.
 *
 * ## Why it exists at all
 *
 * Pressing Approve calls `Approvals.Decide` **through Arcade**, as the clicking
 * user. That is the point of the slice and it is not negotiable — there is no
 * privileged path in `apps/web` that records a decision without a hook. But
 * until #13 registers the gateway and the provider there is no Arcade to call,
 * so `apps/web` pointed at `api.arcade.dev` with no key and the page said
 * "Arcade answered 401". The behaviour was correct and the demo was
 * unrunnable, which is its own kind of wrong: this file was already the fix,
 * living inside `test/harness.ts` where only `bun test` could reach it.
 *
 * It stays useful after #13. A forker who wants to see the flow without an
 * Arcade account, or anyone on a plane, points `ARCADE_API_URL` here.
 *
 * ## What it does, and what that buys
 *
 * Exactly what the engine does for a tool with no auth requirement, and
 * nothing more:
 *
 *   1. `POST /pre` on the real control plane, with the caller's `user_id`.
 *   2. On anything but `OK`, return a failed execution carrying the hook's own
 *      `error_message` and `CHECK_FAILED`. **It does not run the tool.**
 *   3. On `OK`, run the tool — which for `Approvals.Decide` is one HTTP call to
 *      `POST /approvals/{id}/decision`, the same call the deployed Python
 *      worker makes, with `decided_by` taken from the identity the engine
 *      supplies and never from an argument.
 *
 * So the refusal a person sees on the approval page is produced by the actual
 * pre-hook against the actual policy in `governance.db`. The only fiction is
 * the transport. That is what makes it worth shipping rather than mocking: a
 * fixture that answered "denied" from a lookup table would prove nothing, and
 * this one cannot answer at all without asking the control plane first.
 *
 * ## One stand-in, not two
 *
 * `test/harness.ts` imports `createArcadeStandIn` from here rather than
 * carrying its own copy, so the thing the suite proves and the thing a person
 * runs cannot drift apart. That is the whole reason this is a module with a
 * `main` rather than a script.
 */
/**
 * The two bearers the stand-in needs, and the development values it falls back
 * to — the same ones `apps/hooks` falls back to outside production, so the
 * local three-terminal run in `apps/web/README.md` needs no secrets at all.
 * `test/config.test.ts` reads the control plane's source and fails if either
 * literal drifts.
 */
const DEV_HOOK_SECRET = "cg-hooks-dev-secret-not-for-production";
const DEV_STORE_TOKEN = "cg-approvals-store-dev-token-not-for-production";

export interface ArcadeStandInOptions {
  /** The control plane, HOST-form. The stand-in adds the scheme. */
  hooksHost: string;
  /** What `/access`, `/pre` and `/post` require. */
  hookSigningSecret: string;
  /** What the four `/approvals` endpoints require. */
  approvalsStoreToken: string;
  /** `0` lets the OS pick, which is what tests and an unset `PORT` want. */
  port?: number;
  /** Every execution attempt, in order. The suite asserts on this. */
  onExecute?: (call: { user_id: string; tool: string }) => void;
}

/** The path Arcade serves tool execution on, and the only one this answers. */
export const EXECUTE_PATH = "/v1/tools/execute";

export function createArcadeStandIn(options: ArcadeStandInOptions) {
  const { hooksHost, hookSigningSecret, approvalsStoreToken, onExecute } = options;
  const base = hooksHost.startsWith("localhost") || hooksHost.startsWith("127.0.0.1")
    ? `http://${hooksHost}`
    : `https://${hooksHost}`;

  /** Arcade's shape for an execution that did not run, or ran and failed. */
  const failed = (message: string, code?: string) =>
    Response.json({
      success: false,
      output: { error: { message, ...(code === undefined ? {} : { code }), can_retry: false } },
    });

  return Bun.serve({
    port: options.port ?? 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname !== EXECUTE_PATH) {
        return Response.json({ error: "not found" }, { status: 404 });
      }

      const body = (await request.json()) as {
        tool_name?: string;
        input?: Record<string, unknown>;
        user_id?: string;
      };
      const toolName = body.tool_name ?? "";
      const input = body.input ?? {};
      const userId = body.user_id ?? "";
      onExecute?.({ user_id: userId, tool: toolName });

      const [toolkit, name] = toolName.split(".");
      if (toolkit === undefined || name === undefined || name === "") {
        // A person debugging their own curl deserves to be told this rather
        // than to watch the control plane fail closed on an empty tool name.
        return failed(
          `"${toolName}" is not a fully-qualified tool name; the stand-in expects Toolkit.Tool.`,
        );
      }

      // 1. The pre-execution hook, exactly as the engine calls it.
      const pre = await fetch(`${base}/pre`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hookSigningSecret}`,
        },
        body: JSON.stringify({
          execution_id: `tc_${Math.random().toString(36).slice(2, 10)}`,
          tool: { name, toolkit, version: "1.0.0" },
          inputs: input,
          context: { authorization: [{}], user_id: userId },
        }),
      }).catch((cause: unknown) => cause as Error);

      if (pre instanceof Error) {
        return failed(`the control plane at ${base} could not be reached: ${pre.message}`);
      }
      if (pre.status === 401) {
        return failed(
          `the control plane refused the stand-in's hook bearer. Set ` +
            `ARCADE_HOOK_SIGNING_SECRET to the same value apps/hooks has, or unset it on both.`,
        );
      }
      const verdict = (await pre.json()) as { code?: string; error_message?: string };

      // 2. Anything but OK and the tool does not run. This is the branch the
      //    demo is about: the message is the hook's own, verbatim.
      if (verdict.code !== "OK") {
        return failed(verdict.error_message ?? "denied by an extension policy", "CHECK_FAILED");
      }

      // 3. The tool. `Approvals.Decide` is a stateless client of the store.
      if (name !== "Decide") {
        return failed(
          `the stand-in only runs Approvals.Decide; "${toolName}" passed /pre but there is ` +
            `nothing here to execute it. The real toolkits ship with \`arcade deploy\`.`,
        );
      }

      const recorded = await fetch(
        `${base}/approvals/${encodeURIComponent(String(input.request_id))}/decision`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${approvalsStoreToken}`,
          },
          body: JSON.stringify({
            decision: input.decision,
            note: input.note ?? null,
            decided_by: userId,
          }),
        },
      ).catch((cause: unknown) => cause as Error);

      if (recorded instanceof Error) {
        return failed(`the approvals store could not be reached: ${recorded.message}`);
      }
      const payload = (await recorded.json()) as { request?: unknown; error?: string };
      if (!recorded.ok) {
        return failed(payload.error ?? `the approvals store answered ${recorded.status}`);
      }
      return Response.json({ success: true, output: { value: payload.request } });
    },
  });
}

// ---------------------------------------------------------------------------
// Runnable
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const env = process.env;
  // Never a hard-coded port. `PORT` if it is set, otherwise :0 and print what
  // the OS gave us — this worktree owns a block of ten ports and another one
  // owns a different block, so nothing here may pick a number.
  const port = env.PORT === undefined || env.PORT.trim() === "" ? 0 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0) {
    console.error(`[arcade-stand-in] PORT="${env.PORT}" is not a port number`);
    process.exit(1);
  }

  const hooksHost = env.HOOKS_PUBLIC_HOST?.trim() || "localhost:8081";
  const hookSigningSecret = env.ARCADE_HOOK_SIGNING_SECRET?.trim() || DEV_HOOK_SECRET;
  const approvalsStoreToken = env.APPROVALS_STORE_TOKEN?.trim() || DEV_STORE_TOKEN;

  const server = createArcadeStandIn({
    hooksHost,
    hookSigningSecret,
    approvalsStoreToken,
    port,
    onExecute: ({ user_id, tool }) =>
      console.log(`[arcade-stand-in] execute ${tool} as ${user_id}`),
  });

  // Said plainly, on every boot, because a fixture that looks like the product
  // is how a demo ends up being given as evidence of the product.
  console.log(
    `[arcade-stand-in] listening on :${server.port} — this is a STAND-IN for Arcade, for ` +
      `local demos only. It is not the product and it is not in the deployed image.`,
  );
  console.log(
    `[arcade-stand-in] control plane: ${hooksHost} — every execution asks its /pre first and ` +
      `runs nothing when the answer is not OK.`,
  );
  if (env.ARCADE_HOOK_SIGNING_SECRET?.trim() === undefined || env.ARCADE_HOOK_SIGNING_SECRET.trim() === "") {
    console.log("[arcade-stand-in] using the development hook secret; apps/hooks does too.");
  }
  console.log(
    `[arcade-stand-in] point apps/web at it with ARCADE_API_URL=http://localhost:${server.port}`,
  );
}
