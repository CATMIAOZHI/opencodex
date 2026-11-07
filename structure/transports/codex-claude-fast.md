# Codex Claude Fast Control

The local fork defaults `codexClaudeFastSubagentsOnly` to enabled. Its optional boolean is
declared in `src/types/config.ts` and `src/config/schema/config-schema.ts`; explicit false restores
upstream behavior. Catalog capability is unchanged, so an enabled Anthropic provider retains
its Codex Fast picker.

`src/server/responses/codex-claude-fast.ts` captures the original Codex Responses UI intent
before route selection and normalization. Identified Claude requests using the Anthropic
adapter force standard speed. Only the root owner can publish the bounded, process-local,
caller-and-session-scoped toggle. Native ChatGPT GPT workers use its latest observed value,
including continuations with stale caller tiers. Unknown trees retain ordinary routing.
The helper reads pure identity functions from `src/codex/lineage.ts`; it never writes Pool lineage.

Known shadow models without explicit user provenance, internal helper options, and actual
shadow/memory/compaction rewrites cannot publish. Root selection does not assume that
session-id equals thread-id. Switching the root away from Claude releases its workers to
ordinary routing; a sequence tombstone prevents an older delayed Claude request from undoing it.

The next root request communicates a toggle change; already-dispatched requests do not change.
This override precedes global `fastMode`, while destination capability gates still apply.
Messages/Chat ingress is unchanged. State expires after 24 hours without a root update and
is capped at 2048 trees. Restart/eviction restores ordinary child routing until the next
eligible Claude root request.

`src/server/responses/request-prepare.ts` captures the request intent before mutation and
passes helper classification to `src/server/responses/core-normalize.ts`, which applies
the final-route tier decision and observation policy together. Regression coverage is in
`tests/responses/codex-claude-fast.test.ts`: real normalization and serialization, mocked
Responses ingress, catalog retention, isolation, helper provenance, stale requests and bounds.
