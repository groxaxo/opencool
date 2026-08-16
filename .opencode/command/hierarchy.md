---
description: Run a coding task through the architect → local Qwen workers → tester → critic → judge hierarchy
agent: architect
---

Load the `hierarchical-orchestration` skill and route every repository-changing part of the request through the hierarchy.

Use the `hierarchy` MCP to create the run, execute each active packet through OpenCode's native `task` tool with the listed `qwen-*` agent, record the real child-session ID and complete report, rerun any downstream evidence invalidated by retries, and pass the final gate before declaring completion.

The primary context is read-only. Only independent read-only packets may run in parallel; all implementation workers are serialized and verified against their actual repository delta.

## Request

$ARGUMENTS
