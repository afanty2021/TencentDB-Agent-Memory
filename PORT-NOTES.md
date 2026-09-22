# PORT-NOTES — multi-user stores ported onto v3 (feat/server_team)

Branch: `port/multi-user-stores` (base: upstream `feat/server_team` @ 5017e2b).
Source: local `main` multi-user work (plan: docs/plans/2026-09-14-multi-user-memory-stores.md,
commits b21e6ec..20fc1db on the pre-v2 history).

## Why this is a port, not a merge

The upstream v2.0 rewrite (`feat/server_team`) shares no git history with the
local `main` line, and the engine moved from `src/` to `MemoryCore/src/`
(plus a v3 protocol rewrite of the Hermes plugin). Every hunk below was
re-applied by hand and re-verified by tests.

## What was ported (and where it landed)

| Local file | Ported to | Notes |
|---|---|---|
| `src/utils/user-id.ts` (+test) | `MemoryCore/src/utils/user-id.ts` | verbatim; new file upstream |
| `src/gateway/config.ts` multiUser block | `MemoryCore/src/gateway/config.ts` | interface + `resolveMultiUser()` + overrides merge; local api-key piece DROPPED (upstream `server.apiKey` is a superset) |
| `src/gateway/server.ts` multi-user routing | `MemoryCore/src/gateway/server.ts` | LRU/`_resolveCore` block verbatim (0 symbol overlap); 5 v1-protocol handlers rewired to `_resolveCore(body.user_id)`; `/seed` 403 guard; startup log; per-user teardown in stop() |
| `src/gateway/types.ts` | `MemoryCore/src/gateway/types.ts` | added `user_id?` to MemorySearchRequest / ConversationSearchRequest / SeedRequest (Recall/Capture/SessionEnd already had it upstream) |
| `src/utils/checkpoint.ts` `recalculate()` | `MemoryCore/src/utils/checkpoint.ts` | verbatim method |
| `src/core/tdai-core.ts` recalculate wiring | `MemoryCore/src/core/tdai-core.ts` | `wirePipelineRunners` made async + counter reconciliation at top |
| plugin `_normalize_user_id` + identity chain | `MemoryCore/hermes-plugin/memory/memory_tencentdb/__init__.py` | chain adapted to v3: capture goes through `conversation_add(user_id=capture_uid)`; read paths (`prefetch` fan-out + 3 tools) use `_effective_user_id() or self._user_id` |
| plugin test infra + suite | `MemoryCore/hermes-plugin/memory/...` | conftest, hermes_agent_stub, test_multi_user_identity.py — assertions adapted to v3 client methods (see below) |
| `src/gateway/__tests__/multi-user.test.ts` | `MemoryCore/src/gateway/__tests__/` | gateway unit tests |
| `gateway.multi-user.e2e.test.ts` | `MemoryCore/src/gateway/__tests__/` | real-gateway e2e (gated by `TDAI_E2E_REAL_GATEWAY=1`; excluded from default vitest run upstream too) |

## Deliberately NOT ported (with reasons)

1. **Local `server.apiKey` config work** — upstream independently shipped a
   superset (Bearer auth + CORS + non-loopback WARN). Keep upstream's.
2. **api-key dotenv chain (6bb69f0..dcb679f incl. `_dotenv_lookup_bounded`)**
   — upstream has its own `_resolve_gateway_api_key`; whether it needs the
   bounded-lookup / no-leak hardening is a separate audit + PR. Porting our
   pin tests unadapted would fail against upstream's simpler resolver.
3. **`src/core/store/sqlite.ts` FTS5 escaping** — already upstream (PR #529).
4. **Hermes plugin `sync_turn` turn_author default-omit semantics** — v3
   tenancy always tags team/agent/user; `capture_uid` falls back to
   `self._user_id` (never empty) instead of omitting the field.

## Adapted semantics (v1 → v3), preserved contract

- Identity chain unchanged: turn_author snapshot (capture) →
  `on_turn_start._current_user` (recall/search) → static `initialize(user_id)`
  → gateway default pool. The gateway stays the normalization authority
  (fail-closed `^[a-z0-9_-]{1,64}$`, ASCII-only trim).
- 3 plugin tests (`end_session` chain) are `@pytest.mark.skip` — upstream's
  provider-side `end_session` calls are commented out in v3; kept as spec.

## Out of scope for this branch (follow-ups)

- **v3-surface user routing**: chat-memory / knowledge / metadata endpoints
  resolve instances via `ensureMetadataService(instanceId)` and scope content
  by `(teamId, agentId)`. Routing those by end-user is a design task, not a
  port — needs a decision on where `user_id` joins the v3 instance model.
- **Per-user cores in `deployMode: service`**: per-user dataDir isolation is
  proven for standalone sqlite; service mode stores via TCVDB/COS instance
  pools and needs its own isolation design.
- CI wiring for the ported suites on upstream's workflow layout.
