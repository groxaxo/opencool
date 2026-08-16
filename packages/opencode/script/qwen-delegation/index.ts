import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  QwenDelegationService,
  WORKER_ROLES,
  type DelegateInput,
  type WorkerRole,
} from "./service"

type JsonRecord = Record<string, unknown>

const delegateProperties = {
  role: {
    type: "string",
    enum: WORKER_ROLES,
    description: "Worker role. Only builder runs may produce an applicable patch.",
  },
  task: {
    type: "string",
    minLength: 1,
    description: "One bounded objective. Include relevant evidence from prior workers rather than the full parent conversation.",
  },
  scope: {
    type: "array",
    items: { type: "string" },
    description: "Files, directories, packages, or search boundaries relevant to the task.",
  },
  constraints: {
    type: "array",
    items: { type: "string" },
    description: "Non-negotiable constraints and explicitly forbidden changes.",
  },
  acceptance: {
    type: "array",
    items: { type: "string" },
    description: "Observable acceptance criteria, expected checks, and evidence required from the worker.",
  },
  patch_run_id: {
    type: "string",
    description: "Optional builder run ID whose patch is applied to this worker's fresh worktree for independent testing or review.",
  },
  max_minutes: {
    type: "integer",
    minimum: 1,
    maximum: 240,
    description: "Per-worker execution timeout. Defaults to QWEN_MAX_MINUTES or 45 minutes.",
  },
} as const

const tools = [
  {
    name: "doctor",
    description:
      "Check the git workspace, OpenCode executable, architect/worker resources, local OpenAI-compatible Qwen endpoint, and exact model ID before delegating.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delegate",
    description:
      "Run one bounded Qwen worker in a detached git worktree. Builders return a retained binary patch; all roles retain events, reasoning, stderr, prompt, and a compact report.",
    inputSchema: {
      type: "object",
      properties: delegateProperties,
      required: ["role", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "delegate_parallel",
    description:
      "Run up to six independent worker capsules with bounded concurrency. Use for independent exploration or review, not overlapping uncontrolled edits.",
    inputSchema: {
      type: "object",
      properties: {
        jobs: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: delegateProperties,
            required: ["role", "task"],
            additionalProperties: false,
          },
        },
      },
      required: ["jobs"],
      additionalProperties: false,
    },
  },
  {
    name: "read_run",
    description:
      "Read one retained run artifact: compact metadata/report, raw JSON events, generated reasoning, stderr, task prompt, or binary-safe git patch text.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        artifact: {
          type: "string",
          enum: ["metadata", "report", "events", "reasoning", "stderr", "prompt", "patch"],
        },
        max_bytes: { type: "integer", minimum: 1000, maximum: 1000000 },
      },
      required: ["run_id", "artifact"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description:
      "Apply a clean builder patch to the user's current checkout after git apply --check. Does not commit. The architect remains responsible for final diff review and validation.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cleanup",
    description: "Delete the retained artifacts and any stale worktree for one completed worker run.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
] as const

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string when provided`)
  return value
}

function optionalStringArray(record: JsonRecord, key: string): string[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value
}

function optionalInteger(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return value
}

function parseDelegateInput(value: unknown): DelegateInput {
  if (!isRecord(value)) throw new Error("Worker job must be an object")
  const roleValue = requiredString(value, "role")
  if (!WORKER_ROLES.includes(roleValue as WorkerRole)) throw new Error(`Unsupported worker role: ${roleValue}`)

  return {
    role: roleValue as WorkerRole,
    task: requiredString(value, "task"),
    scope: optionalStringArray(value, "scope"),
    constraints: optionalStringArray(value, "constraints"),
    acceptance: optionalStringArray(value, "acceptance"),
    patchRunId: optionalString(value, "patch_run_id"),
    maxMinutes: optionalInteger(value, "max_minutes"),
  }
}

function textResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

if (process.env.QWEN_DELEGATION_CHILD === "1") {
  console.error("Refusing to start the delegation MCP recursively inside a Qwen worker")
  process.exit(2)
}

const service = new QwenDelegationService()
const server = new Server(
  { name: "opencool-qwen-delegation", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const argumentsValue = request.params.arguments ?? {}

  try {
    if (name === "doctor") return textResult(await service.doctor())
    if (name === "delegate") return textResult(await service.delegate(parseDelegateInput(argumentsValue)))
    if (name === "delegate_parallel") {
      if (!isRecord(argumentsValue) || !Array.isArray(argumentsValue.jobs)) throw new Error("jobs must be an array")
      const jobs = argumentsValue.jobs.map(parseDelegateInput)
      return textResult(await service.delegateParallel(jobs))
    }
    if (name === "read_run") {
      if (!isRecord(argumentsValue)) throw new Error("Tool arguments must be an object")
      return textResult(
        await service.readRun(
          requiredString(argumentsValue, "run_id"),
          requiredString(argumentsValue, "artifact"),
          optionalInteger(argumentsValue, "max_bytes"),
        ),
      )
    }
    if (name === "apply_patch") {
      if (!isRecord(argumentsValue)) throw new Error("Tool arguments must be an object")
      return textResult(await service.applyPatch(requiredString(argumentsValue, "run_id")))
    }
    if (name === "cleanup") {
      if (!isRecord(argumentsValue)) throw new Error("Tool arguments must be an object")
      return textResult(await service.cleanup(requiredString(argumentsValue, "run_id")))
    }
    throw new Error(`Unknown tool: ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    }
  }
})

await server.connect(new StdioServerTransport())
