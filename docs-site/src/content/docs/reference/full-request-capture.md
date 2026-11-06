---
title: Full local request capture
description: Opt-in complete request bodies for diagnosing prompt cache changes.
---

This fork provides complete local request capture for the Responses pipeline used
by Codex → OpenCodex → Claude. It is off by default.

```sh
ocx debug requests on
ocx debug requests status
ocx debug requests off
```

These commands change the running proxy without restarting it. The override lasts
until the proxy exits. To enable capture from startup, set
`OPENCODEX_FULL_REQUEST_DEBUG=1`; `ocx debug requests reset` returns to that
environment default. `PUT /api/debug` also accepts `{"requests":true}` or
`{"requests":false}`.

## Files and comparison

Files are written under `$OPENCODEX_HOME/request-captures/`, normally
`~/.opencodex/request-captures/`. Each captured request has a unique directory:

- `0001-inbound.json`: complete decoded UTF-8 JSON before normalization, including
  original whitespace. Compressed transport bytes are decoded first.
- `0002-outbound.json`: complete serialized body at the final HTTP send boundary,
  after image processing, credential rebuilds and other proxy transformations.
  Every retry gets its own sequence number.
- Matching `.meta.json` files: time, method, endpoint path, safe protocol headers,
  body byte count and `complete`. Check that `complete` is true and the body file
  exists before treating a record as complete.
- Matching `.response.json` files: HTTP status or transport failure; these do not
  contain response bodies.
- `result-*.json`: request ID, final status and usage, including cache read and
  one-hour cache-write tokens when reported. Join `requestId` to `usage.jsonl`.

Compare the outbound JSON for a cache hit and a cache miss, especially `tools`,
`system`, early `messages`, image data, `thinking`, `tool_choice` and
`cache_control`. The full prompt, tool outputs and image Base64 are preserved.
Header credentials and other non-allowlisted headers are replaced with equality
tags valid only within the current proxy process; the host and URL query are not
recorded. Prompt bodies themselves are not redacted.

When diagnosing Claude requests with GPT subagents, compare the historical
`thinking` blocks too. Reasoning replay uses each request's own `thread-id`
before the parent thread, so a subagent's model change does not invalidate the
parent's thinking history. A model or account change within the same thread
still applies the normal foreign-reasoning protection.

## Scope and storage

This captures requests handled by the Responses pipeline and its final HTTP
dispatches. It is not a general packet capture: direct native Messages/Chat
ingress, ChatGPT upstream WebSocket frames and provider transports bypassing the
shared HTTP dispatcher are outside this feature's coverage. An unsupported
streaming request body is marked incomplete rather than consumed for logging.

Bodies stay in local files and are not available through dashboard log APIs.
Writes run in the background with at most 64 pending jobs and 512 MiB of queued
payload accounting. A full queue or filesystem error emits an incomplete-capture
warning; requests continue normally and bodies are never silently truncated.
An abrupt process exit can lose pending writes. Successfully written files are
published by rename, so `.tmp` files are not complete records.

There is no automatic deletion or disk quota. Turning capture off stops new body
captures but lets already queued writes and final usage records finish. After
diagnosis, turn it off and remove the capture directory when the files are no
longer needed. Keep these files local: they contain the full conversation,
including any secrets already present in prompt or tool-output text.
