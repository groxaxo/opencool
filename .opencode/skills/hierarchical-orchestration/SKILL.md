---
name: hierarchical-orchestration
description: Mandatory architect-worker-tester-critic workflow for repository-changing local coding with a frontier primary model and Qwen3.8-27B child agents
license: MIT
compatibility: opencode
metadata:
  audience: coding-agents
  workflow: hierarchical-local-orchestration
---

# Hierarchical Orchestration

Use this skill for every coding, debugging, refactoring, migration, or implementation request that changes repository state, and for non-trivial repository-wide reviews.

## Core invariant

The primary model is the **architect and judge**, not the bulk implementation worker.

The local Qwen pool performs bounded execution:

- `qwen-explorer`: verified read-only repository reconnaissance
- `qwen-worker`: scoped implementation
- `qwen-tester`: independent local validation
- `qwen-critic`: independent adversarial review
- `qwen-synthesizer`: optional compression of several reports

OpenCode's native `task` tool is the execution plane. The `hierarchy` MCP is the planning, state, evidence, and acceptance plane.

Do not replace native child sessions with direct chat-completion calls. Child agents need repository tools, isolated contexts, model selection, permissions, resumable task IDs, and independently recorded evidence.

## Primary-agent boundary

The `architect` primary agent is denied direct file edits and shell execution. Every repository mutation and command execution is delegated to a bounded `qwen-*` child session.

The primary model owns:

- user intent and constraints
- decomposition and architecture
- task scopes and dependencies
- arbitration between reports
- retry and integration decisions
- final acceptance and user communication

It must not silently implement a repository-changing task itself. Tiny code changes still use a low-complexity worker plus tester plan. Conceptual questions that do not change repository state may be answered directly.

## Mandatory sequence

### 1. Establish the objective

Read only the nearest governing instructions and enough known entry-point context to state one answerable objective. Do not perform a broad investigation or edit in the primary context.

The orchestration server requires a Git worktree. Do not start a run in a non-Git directory.

### 2. Create the plan

Call `hierarchy_orchestrator_plan` with:

- one precise objective
- `complexity`: `low`, `medium`, `high`, or `critical`
- whether code changes are expected
- explicit constraints
- exact testable acceptance criteria
- bounded workstreams
- exact local validation commands, not prose such as “run tests”

Use stable lowercase task IDs. Every mutating worker must declare a concrete repository-relative scope. Root-wide scopes such as `**` and all `.git` scopes are rejected.

Minimum roles enforced by the MCP:

| Situation | Required roles |
|---|---|
| Any non-trivial run | explorer or worker |
| Code changes | mutating worker + tester |
| Medium or higher | critic |
| High or critical | explorer + worker + tester + critic |

All `worker` tasks are dependency-serialized in declared order. This is intentional: verified workspace-delta attribution is not safe when several writers operate concurrently. Multiple independent read-only explorers may run in parallel.

For large report sets, add a synthesizer before the critic. It is a compression layer, never the final judge.

### 3. Delegate ready packets

The plan returns initial active packets containing:

- `packet_id`
- `subagent_type`
- `description`
- complete bounded prompt
- mutation scope
- dependency context
- workspace and Git-control guards

Invoke OpenCode's native `task` tool once per returned packet. Initial packets are already active; do not call `hierarchy_orchestrator_packet` again unless intentionally rotating one with `replace_active: true`.

Only independent read-only packets may run concurrently. Never run a mutating worker while another packet is active.

Once delegated, do not duplicate the child's work in the primary context.

### 4. Record every child result

Parse the child's `<worker_report>` and call `hierarchy_orchestrator_record` with:

- orchestration `run_id`
- MCP `task_id`
- current opaque `packet_id`
- actual native OpenCode child `task_session_id`
- complete structured report

A `task_session_id` is mandatory and must be unique across independent tasks. Retries of the same task may resume the same child session.

The server independently verifies:

- the packet is current and single-use
- dependencies are complete
- protected Git control state did not change
- read-only packets did not alter tracked or unignored state
- a mutating packet's real net workspace delta stays inside scope
- `files_changed` exactly equals that verified delta
- acceptance evidence references only declared criteria
- only critics return pass/revise/fail verdicts

Never hide a failed worker, low confidence, failed or skipped check, blocker, or risk.

### 5. Advance dependency waves

After recording a result, use the returned ready-task list or call `hierarchy_orchestrator_status`.

For each newly ready task, call `hierarchy_orchestrator_packet`, invoke the returned packet through native `task`, then record the result.

Normal flow:

```text
primary architect
  -> qwen-explorer(s)
  -> serialized qwen-worker(s)
  -> qwen-tester(s)
  -> optional qwen-synthesizer
  -> qwen-critic
  -> primary judge
```

Tester and critic must inspect the final working tree in separate child sessions. Do not reuse an implementation worker's session for independent evidence.

### 6. Retry narrowly

When a task is blocked, fails, or receives a revise verdict:

1. Call `hierarchy_orchestrator_packet` with precise feedback.
2. Resume that task's prior child session when appropriate.
3. Preserve its original scope.
4. Record the new attempt.

An active packet cannot be replaced accidentally. Set `replace_active: true` only when intentionally abandoning the currently issued packet.

A new upstream attempt invalidates all completed downstream tester, synthesizer, and critic evidence. Their old attempts remain in the audit trail but cannot satisfy the gate; rerun the newly ready descendants.

A repeated mutating worker may legitimately report an empty verified delta when its existing implementation remains valid. The first successful mutating attempt must produce a real change.

### 7. Apply the final gate

Call `hierarchy_orchestrator_gate` before claiming completion.

A passing gate requires:

- every required task complete
- no active unrecorded packet
- dependency evidence newer than the latest dependency attempts
- unique independent child-session identities
- exact required commands passed through an independent tester when code changed
- exact independent evidence for every acceptance criterion
- critic `pass` when required
- worker, tester, and critic confidence above the complexity threshold
- no blockers or unresolved high/critical risks
- current workspace and Git-control state matching both the last recorded packet and final independent evidence snapshot

A `revise` decision is binding. Repair the listed gaps through bounded tasks, record fresh evidence, and rerun the gate.

Any tracked, unignored, or protected Git-control mutation after a passing gate blocks acceptance until the evidence chain is refreshed or the exact prior state is restored.

### 8. Finalize

The primary model communicates:

- architecture or behavior changed
- local validation that actually passed
- residual material risk
- commit or PR status when relevant

Call `hierarchy_orchestrator_close` with `accepted` only immediately after a passing gate. Use `abandoned` when stopping with unresolved blockers.

## Local validation policy

- Follow the nearest repository instructions.
- Run package-scoped commands from the correct directory.
- Never use GitHub Actions as the validation mechanism.
- Do not claim a command passed unless a child actually executed it and the result was recorded.
- Preserve exact failure summaries and skipped coverage.
- Avoid tests that rewrite tracked files. Test-generated ignored caches are outside the workspace fingerprint and must remain disposable.

## Safety model and limitations

Agent permissions are defense in depth, not an operating-system sandbox. The MCP therefore verifies net repository state at packet boundaries.

The verified workspace guard covers tracked changes and unignored files, including the contents of already-untracked files. It deliberately excludes ignored build caches and dependency directories so ordinary local tests remain practical.

The protected Git-control guard covers HEAD, current branch, index, local heads and tags, stash, remotes, worktrees, and repository-local config. Workers are also denied ordinary commit, push, remote access, and branch-rewrite commands.

Do not manually edit the repository while a packet is active. The MCP can prove the net delta and continuity, but it cannot identify which local process produced an in-scope change.

## Escalation policy

Escalate to the primary architect when:

- workers disagree on an architectural invariant
- the same bounded retry fails twice
- a high/critical risk cannot be resolved inside scope
- required changes cannot be safely sequenced
- critic evidence contradicts implementation claims

Escalation never erases the evidence trail. Record the failed attempt and the final resolution.
