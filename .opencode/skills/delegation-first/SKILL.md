---
name: delegation-first
description: Enforce a frontier-architect and local-Qwen worker hierarchy for repository coding tasks
license: MIT
compatibility: opencode
metadata:
  architecture: planner-worker-critic-judge
  worker: qwen-local
---

# Delegation First

Use this skill for non-trivial repository work when a strong primary model is paired with the local Qwen delegation MCP.

## Operating model

The primary model is the architect, planner, judge, and user-facing owner. Qwen workers are the engineering team. The architect must not consume expensive context doing mechanical repository work that a bounded worker can perform.

The architect owns:

- interpreting the user's intent and non-negotiable constraints
- choosing architecture and decomposing work
- issuing bounded task capsules
- reconciling conflicting evidence
- reviewing patches and deciding whether they are safe to apply
- accepting the final result and explaining it to the user

Qwen workers own:

- repository reconnaissance and evidence collection
- implementation in isolated git worktrees
- tests, type checks, linting, and reproducible diagnostics
- adversarial review of proposed patches
- synthesis of large worker outputs into compact reports

## Mandatory delegation rule

For any task that changes code, configuration, tests, build logic, schemas, dependencies, or more than one documentation section:

1. Delegate repository reconnaissance unless the exact relevant files and failure are already proven.
2. Delegate implementation to a `builder` worker. The builder may edit only its detached worktree and returns a binary patch.
3. Delegate at least one independent `critic` or `tester` against that patch before applying it.
4. Apply the patch only through `qwen-delegation_apply_patch` after reviewing the worker reports.
5. Run or delegate the repository-local validation required by `AGENTS.md`.

The architect may answer conceptual questions directly. It may also handle a truly trivial one-line correction when no repository investigation, testing, or design judgment is involved. When uncertain, delegate.

## Task capsules

Every worker request must be bounded. Include:

- one explicit objective
- the relevant paths or search boundary
- constraints and forbidden changes
- acceptance criteria
- expected validation commands or evidence
- the requested deliverable

Do not send the entire parent conversation. Pass only the context needed to complete the assigned work.

Example capsule:

```yaml
objective: Add production-grade support for the new model architecture.
scope:
  - packages/opencode/src/provider
  - packages/opencode/test/provider
constraints:
  - preserve existing provider behavior
  - do not change public APIs without evidence
  - do not commit, push, or access GitHub
acceptance:
  - targeted tests pass
  - package typecheck passes
  - unsupported cases are documented
return:
  - concise report
  - binary patch
  - validation evidence
  - unresolved risks
```

## Recommended flow

### 1. Explore

Call `qwen-delegation_delegate` with `role: "explorer"`. Ask for relevant files, local conventions, likely failure modes, and a patch plan. For risky work, run two independent explorers and compare their evidence.

### 2. Build

Call `qwen-delegation_delegate` with `role: "builder"`. Give the reconciled task capsule. The worker edits an isolated detached worktree and returns a run ID plus patch metadata. It never edits the user's checkout directly.

### 3. Critique and test

Pass the builder's run ID as `patch_run_id` to one or both of:

- `role: "critic"` for adversarial code review, regression analysis, and missing-case detection
- `role: "tester"` for targeted tests, type checking, linting, and reproducibility checks

These workers receive the proposed patch in fresh independent worktrees. Treat claims without commands, output, file references, or code evidence as unverified.

### 4. Revise when needed

If a critic identifies a real issue, send a new builder a narrow correction task. Do not ask the original worker to defend its own patch in the same context. Independent contexts reduce anchoring.

### 5. Judge and apply

The architect reviews the reports and patch summary. Apply only an accepted builder run through `qwen-delegation_apply_patch`. Never apply a patch merely because a worker reports high confidence.

### 6. Validate and conclude

Delegate or run the exact package-local validation required by repository instructions. Inspect the final diff. The architect alone decides that the task is complete and writes the final response.

## Parallelism

Use `qwen-delegation_delegate_parallel` only for independent, non-overlapping investigations or reviews. Do not let parallel builders edit the same logical area unless the intention is to compare alternative patches. Keep normal concurrency at three workers on a 3x RTX 3090 host; higher concurrency often loses more to KV-cache, compilation, and disk contention than it gains.

## Escalation

Escalate back to the primary frontier model when:

- workers disagree on architecture or root cause
- a patch crosses security, persistence, billing, authentication, data-loss, or public-API boundaries
- validation is inconclusive
- the worker reports a blocker outside its task capsule
- applying the patch would overwrite unrelated user work

The primary model should solve the disputed judgment, not redo every mechanical step itself.

## Safety and authority

- Workers have no release authority.
- Workers must not commit, push, open pull requests, use `gh`, or read secrets.
- Builders may modify only their detached worktrees.
- Explorers, critics, testers, and synthesizers are treated as read-only; any diff they create is reported as a policy violation and discarded.
- The MCP retains full worker events, reasoning output, stderr, prompt, report, and patch locally, while returning a compact report to the architect.
- The architect must preserve unrelated user changes and inspect the working tree before applying a patch.

## Completion standard

A task is complete only when the accepted patch is applied, required local checks have run, the final diff has been inspected, and remaining risks are stated plainly. Delegation is a means of improving evidence and efficiency; it is never a substitute for final judgment.