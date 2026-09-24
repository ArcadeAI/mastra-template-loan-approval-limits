/**
 * The shape `interop-21.ts` needs from the panel's adapter, declared here
 * because the module is loaded by path at runtime — it lives in `apps/web`,
 * which this service does not depend on and must not start depending on. If
 * #21 changes its signature, this is the file that stops compiling.
 */
import type { GovernanceEvent } from "@cg/policy-schema";

export interface SubscribeOptions {
  onEvents: (events: GovernanceEvent[]) => void;
  onStatus?: (status: string) => void;
  onUnusableFrame?: (data: string, problem: string) => void;
  signal: AbortSignal;
  retryMs?: number;
}

export function subscribeToGovernanceEvents(url: string, options: SubscribeOptions): Promise<void>;
