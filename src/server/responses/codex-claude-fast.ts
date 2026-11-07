import { codexConversationIdentity, codexLineageScopeKey } from "../../codex/lineage";
import { isShadowSourceModel, shadowCallPreservesSelectedModel } from "../../lib/shadow-call";
import { canonicalFastTierMarker } from "../../providers/fastwire";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers-destination";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import type { HandleResponsesOptions } from "./core-options";

export const CODEX_CLAUDE_FAST_TTL_MS = 24 * 60 * 60_000;
export const CODEX_CLAUDE_FAST_MAX_TREES = 2048;

interface TreeControl {
  owner: string;
  fast: boolean | undefined;
  sequence: number;
  updatedAt: number;
}

export interface CodexClaudeFastControl {
  readonly key: string;
  readonly thread: string;
  readonly child: boolean;
  readonly publish: boolean;
  readonly fast: boolean;
  readonly sequence: number;
}

const trees = new Map<string, TreeControl>();
let sequence = 0;

/**
 * Snapshot the UI intent before route selection, tier normalization or asynchronous auth.
 * Never write Pool lineage here: its recording has a separate credential admission boundary.
 */
export function captureCodexClaudeFastControl(
  req: Request,
  body: unknown,
  config: Pick<OcxConfig, "codexClaudeFastSubagentsOnly" | "shadowCallIntercept">,
  options: HandleResponsesOptions = {},
): CodexClaudeFastControl | undefined {
  if (config.codexClaudeFastSubagentsOnly === false || (options.inboundWire ?? "responses") !== "responses") return;
  const identity = codexConversationIdentity(req.headers);
  // Parent-only helpers and unidentified clients cannot own a UI toggle.
  if (!identity?.sessionId || identity.recordThreadId !== req.headers.get("thread-id")?.trim()) return;
  const raw = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const client = raw.client_metadata;
  const metadata = options.inboundTransport === "websocket"
    ? client && typeof client === "object" ? (client as Record<string, unknown>)["x-codex-turn-metadata"] : undefined
    : req.headers.get("x-codex-turn-metadata");
  const subagent = req.headers.get("x-openai-subagent");
  const helper = typeof raw.model === "string" && isShadowSourceModel(raw.model, config.shadowCallIntercept?.sourceModels)
    && !shadowCallPreservesSelectedModel(body, req.headers, options.inboundTransport);
  let child = identity.declaresParent || subagent === "collab_spawn";
  let userTurn = metadata == null;
  if (typeof metadata === "string" && metadata.length <= 16_384) {
    try {
      const turn = JSON.parse(metadata);
      child ||= turn?.subagent_kind === "thread_spawn";
      userTurn = turn?.request_kind === "turn" && turn?.thread_source === "user";
    } catch { /* Malformed provenance cannot change the root's toggle. */ }
  }
  return {
    key: `${codexLineageScopeKey(req.headers)}\0${identity.conversationKey}`,
    thread: identity.recordThreadId,
    child,
    // Preparation may discover a helper/compaction route after capturing the original intent.
    get publish() {
      const internal = options.comboAttempt || options.policyFallbackCandidate || options.internalDecisionCall
        || options.memoryModelPhase || options.visionDescribeTerminal || options.advisorInternal
        || options.shadowCallIntercepted || options.compactionRoutingOverride || options.mainHardLockFallbackOverride;
      return !internal && !helper && !child && !subagent && !req.headers.has("x-codex-parent-thread-id") && userTurn;
    },
    fast: canonicalFastTierMarker(typeof raw.service_tier === "string" ? raw.service_tier : undefined) !== undefined
      || (typeof raw.model === "string" && raw.model.endsWith("--fast") && raw.service_tier === undefined),
    sequence: ++sequence,
  };
}

/**
 * Fork-local request policy, independent of catalog capability. The Claude picker keeps
 * Fast, but only native GPT workers consume that intent. Unknown trees retain normal routing.
 */
export function codexClaudeFastMode(
  config: Pick<OcxConfig, "codexClaudeFastSubagentsOnly" | "fastMode">,
  control: CodexClaudeFastControl | undefined,
  provider: OcxProviderConfig,
  modelId: string,
  now = Date.now(),
): boolean | undefined {
  if (config.codexClaudeFastSubagentsOnly === false || !control) return config.fastMode;
  for (const [key, tree] of trees) {
    if (now - tree.updatedAt <= CODEX_CLAUDE_FAST_TTL_MS) break;
    trees.delete(key);
  }
  const claude = provider.adapter === "anthropic" && modelId.startsWith("claude-");
  let tree = trees.get(control.key);
  if (control.publish && (!tree || tree.owner === control.thread)
    && (!tree || control.sequence > tree.sequence)) {
    // Keep non-Claude tombstones even on a cold tree: a newer root model switch may
    // finish auth before the older, first Claude request has established any state.
    tree = { owner: control.thread, fast: claude ? control.fast : undefined, sequence: control.sequence, updatedAt: now };
    trees.delete(control.key);
    trees.set(control.key, tree);
    while (trees.size > CODEX_CLAUDE_FAST_MAX_TREES) trees.delete(trees.keys().next().value!);
  }
  // Also applies to Claude workers/helpers carrying this Codex identity.
  if (claude) return false;
  if (tree?.fast !== undefined && tree.owner !== control.thread && modelId.startsWith("gpt-")
    && isCanonicalOpenAiForwardProvider(provider)) return tree.fast;
  return config.fastMode;
}

export function resetCodexClaudeFastControlsForTests(): void {
  trees.clear();
  sequence = 0;
}
