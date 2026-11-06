# `juniper_tide`: the 5-hour-only Claude reset offer

## Why

`cedar_ember` (the program the Claude reset-grant surface has always used) clears the
5-hour window **and** the weekly one. Anthropic runs a second program, `juniper_tide`,
that clears the 5-hour window only and is offered at most once a week, at that window's
wall. An operator who has both wants to spend the narrower one when the 5-hour window is
what they hit, so it must appear as its own choice in the dashboard rather than as
"a reset".

## Wire contract

Read from two independent implementations rather than assumed from an older revision:

- `oh-my-pi` — `packages/ai/src/usage/claude-reset.ts` (`JUNIPER_PROGRAM`, juniper status parse)
- `OmniRoute` — `open-sse/services/claudeLimitReset.ts` (`CLAUDE_LIMIT_RESET_PROGRAM`)

```
read:  GET  /api/oauth/usage?at_wall=1&skip_spend=1
       -> body.juniper_tide = { eligible, ineligible_reason, in_experiment,
                                arm: "control"|"reset"|null, available,
                                next_available_at, weekly_resets_at, resets_per_week }
claim: POST /api/organizations/{org}/reset_rate_limits
       body {"program":"juniper_tide"}          <- no grant id, no request id
       -> { result: "reset"|"already_used"|"not_limited"|"ineligible"|"unavailable" }
```

The two reads are different queries: cedar is asked at
`/api/oauth/usage?cedar_ember=1&skip_spend=1`, juniper at `?at_wall=1&skip_spend=1`.

## Decisions

1. **A second module, not a branch inside the first.** `src/providers/anthropic-juniper-reset.ts`
   owns the program. "Cedar behaviour is unchanged" then holds as a property of the file
   list rather than of a careful diff, and the cedar module needs no edit at all.
2. **Spendability is upstream's `available`, never a local re-derivation.** `atLimit` is
   the cedar-wide wall bit and the route applies it to *every* grant, so widening it for
   juniper would light up a cedar grant the server has already refused. `atLimit`,
   `weeklyResetsAt` and `cooldownUntil` therefore keep the cedar value through the merge,
   and the synthetic grant sets `useRequiresLimit: false` because its own wall is already
   inside `available`.
3. **One extra read, only when it can matter.** The juniper probe runs on the read path
   only when cedar has nothing spendable, and on the consume path only for a juniper grant
   id. An unconditional double read would double every dashboard poll, and the existing
   coverage pins the single read (`tests/cli/cli-account-policy.test.ts`,
   `tests/server/management-anthropic-reset-grants.test.ts`).
4. **`juniper_tide: null` is "not evaluated", not "ineligible".** The plain `/usage` body
   leaves every promo program null. A block that is *present* but malformed yields no
   offer, and a transport failure degrades to the cedar answer, so an optional
   entitlement can never turn a working dashboard into an error.
5. **A synthetic grant id.** juniper has no upstream grant id, so the offer carries the
   literal id `juniper_tide`, which satisfies `ANTHROPIC_RESET_GRANT_ID_RE`. The claim
   posts the program alone; the operation id stays a local ledger key and is never sent
   upstream.
6. **No GUI change.** The dashboard renders grants generically, so a synthetic grant with
   `clears: ["five_hour"]` produces the 5-hour chip and a spendable button on its own.
   Only the shared `anthropicGrant.desc` copy was misleading ("5-hour and weekly") and was
   made neutral in all eleven locales.

## Invariants

- Cedar's read count, claim body and response shape are unchanged when cedar has something
  to spend.
- A juniper claim body is exactly `{"program":"juniper_tide"}`.
- An unreadable claim answer is an unknown outcome and is never retried with a new id.
- No token, organization UUID or email reaches a response body or a log line.

## Known deviations

Recorded after an independent read-only audit, so a later reader does not have to
re-derive whether each one was an oversight.

1. **`arm` is only refused when it is explicitly `control`.** oh-my-pi requires
   `arm === "reset"`. A live probe on this deployment answered `arm: null` with
   `in_experiment: false`, so demanding `"reset"` would hide a genuinely spendable
   offer. The relaxation can only ever cause a refused claim, never a wrong spend.
2. **The badge counts one.** `resets_per_week` is not read; `resetsTotal`/`resetsLeft`
   are the literal `1`. The upstream field is the weekly allowance, not the remainder,
   so echoing it could overstate what is left. Understating is the safe direction, and
   the offer itself is decided by `available`.
3. **A failed probe surfaces as `409 grant_not_usable` with reason `unknown_grant`.**
   The analogous cedar failure is `502 upstream_unavailable`. Neither spends anything
   — the gate runs before the journal reservation — so this is legibility only.
4. **The grant label is English.** The dashboard renders `label` as opaque server data
   for both programs (`cedar_ember` labels arrive from upstream in English too), so
   localizing one program's label would need machinery the surface does not have. The
   chip and the button carry the meaning.
5. **There is no idempotency key.** A same-id retry is protected by the unresolved-prior
   window; a *new* id after that window posts again, and the only defence is the
   vendor's weekly budget answering `already_used`.
6. **A theoretical id collision.** A cedar grant whose upstream id happened to be
   `juniper_tide` would be routed to the juniper claim. The vendor does not issue grant
   ids in that namespace today.

## Validation

- `bun test tests/adapters/anthropic/anthropic-reset-grants.test.ts` — 33 pass / 0 fail
- `bun test tests/server/management-anthropic-reset-grants.test.ts` — 22 pass / 0 fail
- `bun test tests/cli/cli-account-policy.test.ts` — unchanged, green
- `bun x tsc --noEmit` — clean
- `bun run structure:check`, `bun run privacy:scan`, `bun run lint:i18n` — green
- `docs-site`: `bun install --frozen-lockfile && bun run build` — 569 pages, internal links checked
- `gui`: `bun run build` — so the packaged `gui/dist` carries the reworded copy
- Independent read-only audit (separate agent, static, no test runs): `AUDIT: PASS`

No live request was made: a real claim spends the account's one weekly chance.
