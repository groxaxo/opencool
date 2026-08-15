---
description: Run a coding task through the Sol architect and local Qwen worker hierarchy
agent: architect
---

Load the `delegation-first` skill and execute the following task through the planner-worker-critic-judge workflow:

$ARGUMENTS

Delegate all non-trivial repository work. Require an isolated builder patch plus independent review or validation before applying it. Preserve unrelated working-tree changes and report the evidence used for final acceptance.