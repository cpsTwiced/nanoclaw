# Fork Changes

Customizations on top of upstream `qwibitai/nanoclaw`. Newest entries first.

Upstream commits land in `main` via `git pull upstream main`. The entries below are the **delta** — work that exists only on this fork.

> Maintenance: when you add a commit to `main` that isn't a pull from upstream, add an entry here.

---

## 2026-04-29

### Codex agent provider

Installed via the `/add-codex` skill (files copied from `upstream/providers`). Adds Codex (OpenAI's app-server) as a per-agent-group provider option alongside the default `claude`.

**Files added:**

- `src/providers/codex.ts` — host-side container config (per-session `~/.codex` mount, copies host `auth.json`, env passthrough for `OPENAI_API_KEY` / `CODEX_MODEL` / `OPENAI_BASE_URL`)
- `container/agent-runner/src/providers/codex.ts` — in-container provider, spawns `codex app-server` via JSON-RPC over stdio
- `container/agent-runner/src/providers/codex-app-server.ts` — app-server protocol client
- `container/agent-runner/src/providers/codex.factory.test.ts` — factory unit test

**Modified:**

- `src/providers/index.ts` + `container/agent-runner/src/providers/index.ts` — append `import './codex.js'` so the provider self-registers
- `container/Dockerfile` — pin `CODEX_VERSION=0.124.0`, install `@openai/codex` globally via pnpm

**Auth:** ChatGPT subscription via `codex login` on host (writes `~/.codex/auth.json`). The host-side provider copies `auth.json` into a per-session mount; the running agent container sees it at `/home/node/.codex/auth.json`.

**Wired groups:**

- `groups/codex-main/` — `agent_provider='codex'`, `provider: 'codex'` in container.json, wired to `#codex-main` Discord channel as a dedicated, single-agent channel.

**Gotcha that bit on first run:** the host process must be restarted (`launchctl kickstart -k`) after installing the provider, or `import './codex.js'` doesn't take effect — the host loaded its barrel at process start. Containers spawned before the restart had no `auth.json` mount and hit `401 Unauthorized` against `api.openai.com`.

### Live-reload of per-group CLAUDE.local.md

**Branch:** `fix/claude-local-live-reload` (merged into `main`)

Two-commit fix so per-group instructions reach the agent and so edits propagate without a container restart.

| Commit | Summary |
|---|---|
| `19b931e` | `feat(agent-runner): inject CLAUDE.local.md into system prompt addendum` — `buildSystemPromptAddendum` now reads `/workspace/agent/CLAUDE.local.md` directly and prepends it to the runtime addendum. Fixes the case where the composed `CLAUDE.md` doesn't reliably pull `CLAUDE.local.md` via `@import`. |
| `934f0a7` | `fix(agent-runner): rebuild system prompt per turn` — `buildSystemPromptAddendum` was being called once at container startup and cached for the lifetime of the poll loop. Replaced the precomputed `instructions` string with a `buildInstructions` factory that the poll loop calls fresh on every turn. CLAUDE.local.md edits + destination-table changes now go live without a restart. |

**Why this matters:** without these, editing `groups/<folder>/CLAUDE.local.md` had no effect until the agent container was killed and respawned. The first commit alone wasn't enough — the cached system prompt at startup meant edits were ignored. Both commits together give true live-reload.

**Reproducing the bug (pre-fix):**

1. Edit `groups/<folder>/CLAUDE.local.md` while the agent container is running.
2. Send a message to the agent. It responds with stale instructions.
3. Restart the container. Now it picks up the edit.

---

## 2026-04-28

### Discord channel adapter

**Commit:** `421c9c2` — `feat(channels): add Discord channel adapter`

Installed via the `/add-discord` skill. Files added/modified:

- `src/channels/discord.ts` — new adapter, registers via `@chat-adapter/discord`
- `src/channels/index.ts` — added `import './discord.js'` to the channel registration barrel
- `package.json` + `pnpm-lock.yaml` — pinned `@chat-adapter/discord` dependency

Bot wired to: DM with `michh`, plus the `#claude-main` server channel under a separate agent group.

### Group cleanup — Main agent retired

**Commit:** `1944865` — `chore: remove default group CLAUDE.md files (Main agent retired)`

Removed `groups/global/CLAUDE.md` and `groups/main/CLAUDE.md` after retiring the original "Main" agent group. Per-group instructions for active agents live in `groups/<folder>/CLAUDE.local.md` (gitignored).

### Auto-mode permission rule in CLAUDE.md

**Commit:** `79b4e5e` — `chore: add auto-mode permission rule to CLAUDE.md`

Added a `## Working Mode` section to the project `CLAUDE.md` requiring Claude Code to ask permission before making code changes when running in auto mode.

---

## Notes

- **`groups/<folder>/CLAUDE.local.md`** files are gitignored by upstream design. They hold per-group agent instructions and live only on this machine. They are NOT tracked here — back them up separately if you care about them. Backups currently live at `~/nanoclaw-backups/`.
- **OneCLI vault state, `data/v2.db`, `data/v2-sessions/`** — all gitignored, not part of the fork delta.
- **`upstream`** remote points to `https://github.com/qwibitai/nanoclaw.git`. **`origin`** points to `git@github.com:cpsTwiced/nanoclaw.git`.
