# OpenCool Hierarchical Orchestrator

This package turns OpenCool/OpenCode into a deliberate two-tier local coding system:

```text
frontier primary model
  architect / planner / integrator / judge
                    │
                    │ validated packets
                    ▼
OpenCode native child sessions on local Qwen3.8-27B
  explorer / serialized worker / tester / critic / synthesizer
                    │
                    │ structured reports + verified state
                    ▼
MCP acceptance gate → primary-model final decision
```

The MCP is the **policy, continuity, and evidence plane**, not another chat-completion wrapper. OpenCode's native `task` tool remains the execution plane because it provides child sessions, repository tools, model-pinned agents, resumable task IDs, permissions, and isolated contexts.

## Components

| Component | Purpose |
|---|---|
| `architect` | Read-only primary agent that decomposes, delegates, arbitrates, and decides acceptance |
| `qwen-explorer` | Verified read-only repository reconnaissance |
| `qwen-worker` | Scoped implementation worker |
| `qwen-tester` | Independent local validation with verified read-only repository state |
| `qwen-critic` | Independent adversarial final review |
| `qwen-synthesizer` | Optional tool-free report compression |
| `hierarchical-orchestration` | Mandatory operating skill |
| `hierarchy` MCP | Plan validation, packet lifecycle, state verification, evidence gate, archival |
| `/hierarchy` | Explicit command for the workflow |
| `install-global.mjs` | Installs the hierarchy under the user's OpenCode config directory |

## Local Qwen endpoint

The checked-in provider expects:

```text
http://127.0.0.1:12434/v1
```

with served model ID:

```text
qwen3.8-27b
```

The endpoint must support OpenAI-compatible tool calls. The model config declares reasoning, `reasoning_content` interleaving, 262,144 context tokens, 32,768 output tokens, no full-request timeout, and a 120-second chunk timeout. Lower those limits when the inference server uses a smaller KV-cache profile.

## Verify

MCP only:

```bash
node .opencode/mcp/hierarchical-orchestrator/doctor.mjs --mcp-only
```

MCP plus local Qwen:

```bash
node .opencode/mcp/hierarchical-orchestrator/doctor.mjs
```

Custom endpoint, model, and key:

```bash
node .opencode/mcp/hierarchical-orchestrator/doctor.mjs \
  --base-url http://127.0.0.1:12569/v1 \
  --model qwen3.8-27b \
  --api-key local
```

Run local integration tests:

```bash
node --test .opencode/mcp/hierarchical-orchestrator/test/*.test.mjs
```

## Project-local startup

The project MCP command discovers the Git worktree root before importing the server, so OpenCode may be started from a nested directory inside the repository. Planning requires a Git worktree.

Project-local state is stored under the ignored path:

```text
.opencode/orchestration/state/
```

State directories use private permissions where supported, and run files are written with mode `0600` on POSIX systems.

## Install globally

```bash
node .opencode/mcp/hierarchical-orchestrator/install-global.mjs
```

The installer:

- copies only hierarchy-owned agents and commands
- installs the skill and MCP
- merges the local Qwen provider and MCP configuration
- uses the current Node executable for the MCP command
- sets `architect` as default unless `--no-default` is supplied
- stores state under the user state directory, partitioned by workspace hash
- writes a timestamped backup before the first changed rewrite of an existing config
- avoids another backup or rewrite when the resulting config is unchanged

The first merge normalizes an existing `opencode.jsonc` to formatted JSON. Comments are preserved in the timestamped backup, not in the rewritten file.

Custom endpoint:

```bash
node .opencode/mcp/hierarchical-orchestrator/install-global.mjs \
  --base-url http://127.0.0.1:12569/v1 \
  --served-model qwen3.8-27b \
  --api-key local
```

Preview:

```bash
node .opencode/mcp/hierarchical-orchestrator/install-global.mjs --dry-run
```

Keep another default agent:

```bash
node .opencode/mcp/hierarchical-orchestrator/install-global.mjs --no-default
```

## Use

The repository config selects `architect` by default. You can also choose it explicitly while selecting any frontier primary model:

```bash
opencode --agent architect --model <provider>/<model>
```

Or invoke:

```text
/hierarchy Add the requested feature, local regression tests, and documentation.
```

The primary model then:

1. loads `hierarchical-orchestration`
2. calls `hierarchy_orchestrator_plan`
3. runs initial active packets with native `task`
4. records reports with packet and child-session IDs
5. requests later dependency packets
6. reruns invalidated downstream evidence after upstream retries
7. calls the final gate
8. closes an accepted or abandoned run

## MCP tools

### `hierarchy_orchestrator_plan`

Validates objective, complexity, exact acceptance criteria, role requirements, scopes, and dependency graph. It rejects root-wide and `.git` mutation scopes, serializes all workers, captures the initial repository guards, and returns active packets for the first read-only or single-writer wave.

### `hierarchy_orchestrator_packet`

Issues the next single-use packet only when dependencies are complete and repository continuity matches the last recorded state. Existing active packets require explicit `replace_active: true` rotation. A mutating packet cannot overlap another active packet.

### `hierarchy_orchestrator_record`

Requires a current packet and unique child-session identity. It independently compares protected Git state, computes the real workspace delta, enforces scope, requires `files_changed` to match exactly, records post-task guards, and invalidates completed downstream evidence after an upstream retry.

### `hierarchy_orchestrator_status`

Shows task state, current guards, invalidation provenance, latest evidence, dependency blockers, and ready tasks. Without a run ID, it lists recent open runs.

### `hierarchy_orchestrator_gate`

Requires completed current evidence, independent exact tests for code changes, critic approval when required, sufficient confidence, declared acceptance evidence, no severe unresolved risk, no active packet, and a repository state matching the final independent evidence snapshot.

### `hierarchy_orchestrator_close`

Archives accepted or abandoned runs. Acceptance requires both a current passing decision and an immediately preceding stored pass over the exact same workspace and Git-control state.

## Safety properties

- The primary architect cannot use ordinary edit or shell tools.
- Qwen workers cannot recursively delegate or invoke hierarchy control tools.
- Worker tasks are serialized for deterministic delta attribution.
- Read-only tasks are rejected if tracked or unignored state changes.
- Untracked file contents, not only filenames, are fingerprinted.
- Mutating reports are checked against the actual net delta and declared scope.
- HEAD, branch, index, heads/tags, stash, remotes, worktrees, and local Git config are separately guarded.
- Child-session IDs cannot be reused across independent tasks.
- Upstream retries invalidate stale downstream evidence.
- Post-evidence and post-gate mutations block acceptance.
- Validation is local; GitHub Actions is not part of the workflow.

Agent shell permissions are defense in depth rather than a process sandbox. Ignored test caches are intentionally not fingerprinted, and no manual repository edits should occur while a packet is active.
