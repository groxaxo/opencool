import { createHash, randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const WORKER_ROLES = ["explorer", "builder", "tester", "critic", "synthesizer"] as const

export type WorkerRole = (typeof WORKER_ROLES)[number]

type JsonRecord = Record<string, unknown>

type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

type WorkerCommandReport = {
  command: string
  status: "passed" | "failed" | "not_run"
  detail?: string
}

export type WorkerReport = {
  status: "complete" | "partial" | "blocked" | "failed"
  summary: string
  files: string[]
  commands: WorkerCommandReport[]
  risks: string[]
  next_steps: string[]
  confidence: number
}

export type DelegateInput = {
  role: WorkerRole
  task: string
  scope?: string[]
  constraints?: string[]
  acceptance?: string[]
  patchRunId?: string
  maxMinutes?: number
}

export type DelegateResult = {
  run_id: string
  role: WorkerRole
  status: WorkerReport["status"]
  summary: string
  confidence: number
  files: string[]
  commands: WorkerCommandReport[]
  risks: string[]
  next_steps: string[]
  patch_available: boolean
  patch_bytes: number
  patch_stat: string
  artifacts: {
    metadata: string
    report: string
    events: string
    reasoning: string
    stderr: string
    prompt: string
    patch?: string
  }
}

type RunMetadata = {
  id: string
  role: WorkerRole
  task: string
  scope: string[]
  constraints: string[]
  acceptance: string[]
  patch_run_id?: string
  status: "running" | WorkerReport["status"]
  started_at: string
  finished_at?: string
  base_commit: string
  worker_model: string
  worker_variant: string
  worker_exit_code?: number
  worker_timed_out?: boolean
  report?: WorkerReport
  files_changed?: string[]
  patch_bytes?: number
  patch_stat?: string
  policy_violation?: string
  applied_at?: string
  artifacts: DelegateResult["artifacts"]
}

type ParsedWorkerOutput = {
  text: string
  reasoning: string
  tools: string[]
  errors: string[]
}

export type QwenDelegationOptions = {
  cwd?: string
  stateDir?: string
  worktreeDir?: string
  workerCommand?: string[]
}

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,80}$/
const WORKER_STATUSES = new Set<WorkerReport["status"]>(["complete", "partial", "blocked", "failed"])
const COMMAND_STATUSES = new Set<WorkerCommandReport["status"]>(["passed", "failed", "not_run"])

const ROLE_GUIDANCE: Record<WorkerRole, string> = {
  explorer:
    "Inspect the repository and return evidence, relevant paths, local conventions, likely failure modes, and a recommended patch plan. Do not modify files.",
  builder:
    "Implement the bounded task in this detached worktree. Run relevant package-local checks. Leave all changes uncommitted for patch capture.",
  tester:
    "Evaluate the supplied patch in this fresh worktree. Run the requested checks and report exact commands and material output. Do not modify files.",
  critic:
    "Review the supplied patch adversarially for correctness, regressions, security, scope, maintainability, and missing tests. Do not modify files.",
  synthesizer:
    "Compress the supplied evidence into a concise decision-ready report. Resolve duplicates and surface disagreements. Do not modify files.",
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function createRunId(role: WorkerRole): string {
  return `${role}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid run ID: ${runId}`)
}

function assertInside(parent: string, child: string): void {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  if (resolvedChild !== resolvedParent && !resolvedChild.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new Error(`Refusing path outside ${resolvedParent}: ${resolvedChild}`)
  }
}

function relativePath(root: string, target: string): string {
  const relative = path.relative(root, target)
  return relative.length === 0 ? "." : relative
}

function workerCommandFromEnvironment(): string[] {
  const configured = process.env.QWEN_OPENCODE_COMMAND
  if (!configured) return ["opencode"]

  let parsed: unknown
  try {
    parsed = JSON.parse(configured)
  } catch {
    throw new Error("QWEN_OPENCODE_COMMAND must be a JSON array of command arguments")
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === "string")) {
    throw new Error("QWEN_OPENCODE_COMMAND must be a non-empty JSON string array")
  }

  return parsed
}

function safeBaseEnvironment(): Record<string, string> {
  const result: Record<string, string> = {}
  const allowed = [
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TZ",
    "NO_PROXY",
    "no_proxy",
  ]

  for (const key of allowed) {
    const value = process.env[key]
    if (value) result[key] = value
  }

  const noProxy = result.NO_PROXY ?? result.no_proxy ?? ""
  const localEntries = ["127.0.0.1", "localhost", "::1"]
  result.NO_PROXY = [...new Set([...noProxy.split(",").filter(Boolean), ...localEntries])].join(",")
  result.no_proxy = result.NO_PROXY
  return result
}

async function runCommand(input: {
  command: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  allowFailure?: boolean
}): Promise<CommandResult> {
  if (input.command.length === 0) throw new Error("Cannot execute an empty command")

  const processHandle = Bun.spawn(input.command, {
    cwd: input.cwd,
    env: input.env ?? safeBaseEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdoutPromise = new Response(processHandle.stdout).text()
  const stderrPromise = new Response(processHandle.stderr).text()
  let timedOut = false
  const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000
  const timeout = setTimeout(() => {
    timedOut = true
    processHandle.kill()
  }, timeoutMs)

  const exitCode = await processHandle.exited
  clearTimeout(timeout)
  const stdout = await stdoutPromise
  const stderr = await stderrPromise
  const result = { exitCode, stdout, stderr, timedOut }

  if (!input.allowFailure && (exitCode !== 0 || timedOut)) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`
    throw new Error(`${input.command.join(" ")} failed: ${detail.slice(0, 4000)}`)
  }

  return result
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await Bun.file(filePath).text())
}

function normalizeCommandReport(value: unknown): WorkerCommandReport | undefined {
  if (!isRecord(value)) return undefined
  const command = asString(value.command)
  const status = asString(value.status)
  if (!command || !status || !COMMAND_STATUSES.has(status as WorkerCommandReport["status"])) return undefined
  const detail = asString(value.detail)
  return detail ? { command, status: status as WorkerCommandReport["status"], detail } : { command, status: status as WorkerCommandReport["status"] }
}

function normalizeWorkerReport(value: unknown): WorkerReport | undefined {
  if (!isRecord(value)) return undefined
  const status = asString(value.status)
  const summary = asString(value.summary)
  if (!status || !summary || !WORKER_STATUSES.has(status as WorkerReport["status"])) return undefined

  const confidenceValue = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? value.confidence : 0
  const commands = Array.isArray(value.commands)
    ? value.commands.map(normalizeCommandReport).filter((item): item is WorkerCommandReport => item !== undefined)
    : []

  return {
    status: status as WorkerReport["status"],
    summary,
    files: asStringArray(value.files),
    commands,
    risks: asStringArray(value.risks),
    next_steps: asStringArray(value.next_steps),
    confidence: clamp(confidenceValue, 0, 1),
  }
}

export function extractWorkerReport(text: string): WorkerReport | undefined {
  const pattern = /<worker_report>\s*([\s\S]*?)\s*<\/worker_report>/g
  let match: RegExpExecArray | null
  let report: WorkerReport | undefined

  while ((match = pattern.exec(text)) !== null) {
    try {
      const parsed = normalizeWorkerReport(JSON.parse(match[1]))
      if (parsed) report = parsed
    } catch {
      continue
    }
  }

  return report
}

export function parseWorkerOutput(stdout: string): ParsedWorkerOutput {
  const text: string[] = []
  const reasoning: string[] = []
  const tools: string[] = []
  const errors: string[] = []
  let parsedEvents = 0

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(event)) continue
    parsedEvents += 1

    const eventType = asString(event.type)
    const part = isRecord(event.part) ? event.part : undefined
    const partText = part ? asString(part.text) : undefined

    if (eventType === "text" && partText) text.push(partText)
    if (eventType === "reasoning" && partText) reasoning.push(partText)
    if (eventType === "tool_use" && part) {
      const tool = asString(part.tool) ?? asString(part.name) ?? "unknown-tool"
      const state = isRecord(part.state) ? asString(part.state.status) : undefined
      tools.push(state ? `${tool}:${state}` : tool)
    }
    if (eventType === "error") errors.push(formatUnknown(event.error ?? event))
  }

  if (parsedEvents === 0 && stdout.trim()) text.push(stdout.trim())
  return {
    text: text.join("\n\n"),
    reasoning: reasoning.join("\n\n"),
    tools,
    errors,
  }
}

function fallbackReport(parsed: ParsedWorkerOutput, result: CommandResult): WorkerReport {
  const summary = parsed.text.trim().slice(0, 6000) || result.stderr.trim().slice(0, 6000) || "Worker returned no report"
  const risks = [...parsed.errors]
  if (result.timedOut) risks.push("Worker exceeded its execution timeout")
  if (result.exitCode !== 0) risks.push(`Worker process exited with code ${result.exitCode}`)

  return {
    status: result.exitCode === 0 && !result.timedOut ? "partial" : "failed",
    summary,
    files: [],
    commands: [],
    risks,
    next_steps: ["Inspect the retained worker transcript and issue a narrower task capsule"],
    confidence: 0,
  }
}

function createPrompt(input: DelegateInput, repositoryRoot: string): string {
  const scope = input.scope?.length ? input.scope.map((item) => `- ${item}`).join("\n") : "- Repository-wide only where necessary"
  const constraints = input.constraints?.length
    ? input.constraints.map((item) => `- ${item}`).join("\n")
    : "- Preserve existing behavior outside the stated objective\n- Follow AGENTS.md and nested repository instructions\n- Do not commit, push, publish, or access GitHub"
  const acceptance = input.acceptance?.length
    ? input.acceptance.map((item) => `- ${item}`).join("\n")
    : "- Return evidence sufficient for the architect to judge the result"
  const patchContext = input.patchRunId
    ? `A proposed patch from run ${input.patchRunId} has already been applied to this isolated worktree for evaluation.`
    : "No prior worker patch is supplied."

  return `You are a bounded local engineering worker under a frontier architect.\n\nRole: ${input.role}\nRepository: ${repositoryRoot}\n\nRole contract:\n${ROLE_GUIDANCE[input.role]}\n\nObjective:\n${input.task}\n\nScope:\n${scope}\n\nConstraints:\n${constraints}\n\nAcceptance criteria:\n${acceptance}\n\nPatch context:\n${patchContext}\n\nDo not broaden the task. Inspect applicable AGENTS.md files before acting. Use repository-local commands and return exact evidence. At completion emit exactly one <worker_report> JSON envelope in the format required by the qwen-worker agent, with nothing after it.`
}

export class QwenDelegationService {
  private readonly cwd: string
  private readonly configuredStateDir?: string
  private readonly configuredWorktreeDir?: string
  private readonly workerCommand: string[]
  private readonly activeRuns = new Set<string>()
  private repositoryRoot?: string

  constructor(options: QwenDelegationOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd())
    this.configuredStateDir = options.stateDir ? path.resolve(options.stateDir) : undefined
    this.configuredWorktreeDir = options.worktreeDir ? path.resolve(options.worktreeDir) : undefined
    this.workerCommand = options.workerCommand ?? workerCommandFromEnvironment()
  }

  async doctor(): Promise<JsonRecord> {
    const repositoryRoot = await this.resolveRepositoryRoot()
    const baseURL = process.env.QWEN_BASE_URL ?? "http://127.0.0.1:8000/v1"
    const model = process.env.QWEN_MODEL ?? "Qwen/Qwen3.8-27B"
    const commandCheck = await runCommand({
      command: ["which", this.workerCommand[0]],
      cwd: repositoryRoot,
      allowFailure: true,
      timeoutMs: 5000,
    })

    let endpointReachable = false
    let modelFound = false
    let endpointDetail = ""
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    try {
      const response = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY ?? "local"}` },
        signal: controller.signal,
      })
      endpointReachable = response.ok
      const body: unknown = await response.json()
      if (isRecord(body) && Array.isArray(body.data)) {
        modelFound = body.data.some((entry) => isRecord(entry) && entry.id === model)
      }
      endpointDetail = response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}: ${formatUnknown(body).slice(0, 500)}`
    } catch (error) {
      endpointDetail = error instanceof Error ? error.message : formatUnknown(error)
    } finally {
      clearTimeout(timeout)
    }

    const stateDir = await this.stateDir()
    const architectExists = await Bun.file(path.join(repositoryRoot, ".opencode", "agent", "architect.md")).exists()
    const workerExists = await Bun.file(path.join(repositoryRoot, ".opencode", "agent", "qwen-worker.md")).exists()
    const skillExists = await Bun.file(path.join(repositoryRoot, ".opencode", "skills", "delegation-first", "SKILL.md")).exists()

    return {
      ready: commandCheck.exitCode === 0 && endpointReachable && modelFound && architectExists && workerExists && skillExists,
      repository_root: repositoryRoot,
      state_dir: stateDir,
      worker_command: this.workerCommand,
      opencode_found: commandCheck.exitCode === 0,
      qwen_base_url: baseURL,
      qwen_model: model,
      endpoint_reachable: endpointReachable,
      model_found: modelFound,
      endpoint_detail: endpointDetail,
      architect_agent_found: architectExists,
      qwen_worker_agent_found: workerExists,
      delegation_skill_found: skillExists,
      hint: modelFound
        ? "The delegation runtime is configured."
        : "Set QWEN_MODEL to the exact model ID returned by the local OpenAI-compatible /models endpoint.",
    }
  }

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    if (!WORKER_ROLES.includes(input.role)) throw new Error(`Unsupported worker role: ${input.role}`)
    if (!input.task.trim()) throw new Error("Worker task cannot be empty")

    const repositoryRoot = await this.resolveRepositoryRoot()
    const stateDir = await this.stateDir()
    const worktreeBase = await this.worktreeDir()
    const runId = createRunId(input.role)
    const runDir = this.runDir(stateDir, runId)
    const worktree = path.join(worktreeBase, runId)
    const prompt = createPrompt(input, repositoryRoot)
    const baseCommit = (await this.git(["rev-parse", "HEAD"], repositoryRoot)).stdout.trim()
    const model = process.env.QWEN_MODEL ?? "Qwen/Qwen3.8-27B"
    const variant = process.env.QWEN_VARIANT ?? "xhigh"
    const artifacts = this.artifactPaths(repositoryRoot, runDir)
    const startedAt = new Date().toISOString()
    let worktreeCreated = false

    await mkdir(runDir, { recursive: true })
    await mkdir(worktreeBase, { recursive: true })
    await Bun.write(path.join(runDir, "prompt.md"), `${prompt}\n`)

    const initialMetadata: RunMetadata = {
      id: runId,
      role: input.role,
      task: input.task,
      scope: input.scope ?? [],
      constraints: input.constraints ?? [],
      acceptance: input.acceptance ?? [],
      patch_run_id: input.patchRunId,
      status: "running",
      started_at: startedAt,
      base_commit: baseCommit,
      worker_model: model,
      worker_variant: variant,
      artifacts,
    }
    await writeJson(path.join(runDir, "run.json"), initialMetadata)
    this.activeRuns.add(runId)

    try {
      await this.git(["worktree", "add", "--detach", worktree, baseCommit], repositoryRoot)
      worktreeCreated = true

      if (input.patchRunId) {
        const patchPath = await this.patchPathForRun(input.patchRunId)
        await this.git(["apply", "--check", patchPath], worktree)
        await this.git(["apply", "--whitespace=nowarn", patchPath], worktree)
      }

      const result = await this.runWorker({
        worktree,
        runDir,
        prompt,
        maxMinutes: clamp(input.maxMinutes ?? Number(process.env.QWEN_MAX_MINUTES ?? 45), 1, 240),
      })
      const parsed = parseWorkerOutput(result.stdout)
      await Bun.write(path.join(runDir, "reasoning.md"), parsed.reasoning ? `${parsed.reasoning}\n` : "")

      let report = extractWorkerReport(parsed.text) ?? fallbackReport(parsed, result)
      if (result.timedOut) {
        report = {
          ...report,
          status: "failed",
          risks: [...report.risks, "Worker timed out before completing its task"],
          confidence: 0,
        }
      } else if (result.exitCode !== 0 && report.status === "complete") {
        report = {
          ...report,
          status: "failed",
          risks: [...report.risks, `Worker process exited with code ${result.exitCode}`],
          confidence: Math.min(report.confidence, 0.2),
        }
      }

      const diff = await this.captureDiff(worktree)
      let policyViolation: string | undefined
      if (input.role !== "builder" && diff.patch.length > 0) {
        policyViolation = `${input.role} worker modified ${diff.files.length} file(s); non-builder changes were discarded`
        report = {
          ...report,
          status: "failed",
          risks: [policyViolation, ...report.risks],
          confidence: 0,
        }
      }

      if (diff.patch.length > 0) await Bun.write(path.join(runDir, "changes.patch"), diff.patch)
      await writeJson(path.join(runDir, "report.json"), report)

      const metadata: RunMetadata = {
        ...initialMetadata,
        status: report.status,
        finished_at: new Date().toISOString(),
        worker_exit_code: result.exitCode,
        worker_timed_out: result.timedOut,
        report,
        files_changed: diff.files,
        patch_bytes: Buffer.byteLength(diff.patch),
        patch_stat: diff.stat,
        policy_violation: policyViolation,
        artifacts: {
          ...artifacts,
          patch: diff.patch.length > 0 ? relativePath(repositoryRoot, path.join(runDir, "changes.patch")) : undefined,
        },
      }
      await writeJson(path.join(runDir, "run.json"), metadata)
      return this.toDelegateResult(metadata)
    } catch (error) {
      const message = error instanceof Error ? error.message : formatUnknown(error)
      const report: WorkerReport = {
        status: "failed",
        summary: `Delegation run failed: ${message}`,
        files: [],
        commands: [],
        risks: [message],
        next_steps: ["Run qwen-delegation_doctor and retry with a narrower task capsule"],
        confidence: 0,
      }
      await writeJson(path.join(runDir, "report.json"), report)
      const metadata: RunMetadata = {
        ...initialMetadata,
        status: "failed",
        finished_at: new Date().toISOString(),
        report,
        files_changed: [],
        patch_bytes: 0,
        patch_stat: "",
      }
      await writeJson(path.join(runDir, "run.json"), metadata)
      return this.toDelegateResult(metadata)
    } finally {
      if (worktreeCreated) await this.removeWorktree(repositoryRoot, worktree)
      this.activeRuns.delete(runId)
    }
  }

  async delegateParallel(inputs: DelegateInput[]): Promise<DelegateResult[]> {
    if (inputs.length === 0) return []
    if (inputs.length > 6) throw new Error("At most six worker jobs may be submitted together")

    const concurrency = clamp(Number(process.env.QWEN_MAX_PARALLEL ?? 3), 1, 6)
    const results = new Array<DelegateResult>(inputs.length)
    let cursor = 0

    const runner = async (): Promise<void> => {
      while (cursor < inputs.length) {
        const index = cursor
        cursor += 1
        results[index] = await this.delegate(inputs[index])
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => runner()))
    return results
  }

  async applyPatch(runId: string): Promise<JsonRecord> {
    assertRunId(runId)
    const repositoryRoot = await this.resolveRepositoryRoot()
    const stateDir = await this.stateDir()
    const metadata = await this.readMetadata(stateDir, runId)
    if (metadata.role !== "builder") throw new Error(`Run ${runId} is a ${metadata.role} run, not a builder patch`)
    if (metadata.applied_at) throw new Error(`Run ${runId} was already applied at ${metadata.applied_at}`)

    const patchPath = await this.patchPathForRun(runId)
    const before = (await this.git(["status", "--short"], repositoryRoot)).stdout
    await this.git(["apply", "--check", patchPath], repositoryRoot)
    await this.git(["apply", "--whitespace=nowarn", patchPath], repositoryRoot)
    const after = (await this.git(["status", "--short"], repositoryRoot)).stdout
    const appliedAt = new Date().toISOString()
    await writeJson(path.join(this.runDir(stateDir, runId), "run.json"), { ...metadata, applied_at: appliedAt })

    return {
      run_id: runId,
      applied_at: appliedAt,
      patch_bytes: metadata.patch_bytes ?? 0,
      patch_stat: metadata.patch_stat ?? "",
      pre_existing_worktree_status: before.trim(),
      resulting_worktree_status: after.trim(),
      note: "Patch applied without committing. The architect must inspect the final diff and complete repository-local validation.",
    }
  }

  async readRun(runId: string, artifact: string, maxBytes = 200_000): Promise<JsonRecord> {
    assertRunId(runId)
    const stateDir = await this.stateDir()
    const runDir = this.runDir(stateDir, runId)
    const artifactFiles: Record<string, string> = {
      metadata: "run.json",
      report: "report.json",
      events: "events.jsonl",
      reasoning: "reasoning.md",
      stderr: "stderr.log",
      prompt: "prompt.md",
      patch: "changes.patch",
    }
    const fileName = artifactFiles[artifact]
    if (!fileName) throw new Error(`Unknown artifact ${artifact}; expected ${Object.keys(artifactFiles).join(", ")}`)

    const filePath = path.join(runDir, fileName)
    assertInside(runDir, filePath)
    if (!(await Bun.file(filePath).exists())) throw new Error(`Artifact ${artifact} does not exist for run ${runId}`)
    const content = await Bun.file(filePath).text()
    const limit = clamp(maxBytes, 1000, 1_000_000)
    const truncated = content.length > limit

    return {
      run_id: runId,
      artifact,
      truncated,
      bytes: Buffer.byteLength(content),
      content: truncated ? content.slice(0, limit) : content,
    }
  }

  async cleanup(runId: string): Promise<JsonRecord> {
    assertRunId(runId)
    if (this.activeRuns.has(runId)) throw new Error(`Run ${runId} is still active`)

    const repositoryRoot = await this.resolveRepositoryRoot()
    const stateDir = await this.stateDir()
    const worktreeBase = await this.worktreeDir()
    const runDir = this.runDir(stateDir, runId)
    const worktree = path.join(worktreeBase, runId)
    assertInside(worktreeBase, worktree)

    await this.removeWorktree(repositoryRoot, worktree)
    const existed = await Bun.file(path.join(runDir, "run.json")).exists()
    await rm(runDir, { recursive: true, force: true })
    return { run_id: runId, removed: existed }
  }

  private async resolveRepositoryRoot(): Promise<string> {
    if (this.repositoryRoot) return this.repositoryRoot
    const result = await runCommand({ command: ["git", "rev-parse", "--show-toplevel"], cwd: this.cwd })
    this.repositoryRoot = path.resolve(result.stdout.trim())
    return this.repositoryRoot
  }

  private async stateDir(): Promise<string> {
    const repositoryRoot = await this.resolveRepositoryRoot()
    const stateDir = this.configuredStateDir ?? path.join(repositoryRoot, ".opencode", "delegation")
    assertInside(repositoryRoot, stateDir)
    await mkdir(path.join(stateDir, "runs"), { recursive: true })
    return stateDir
  }

  private async worktreeDir(): Promise<string> {
    const repositoryRoot = await this.resolveRepositoryRoot()
    const repositoryKey = createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 16)
    const worktreeDir = this.configuredWorktreeDir ?? path.join(os.homedir(), ".cache", "opencool", "qwen-delegation", repositoryKey)
    await mkdir(worktreeDir, { recursive: true })
    return worktreeDir
  }

  private runDir(stateDir: string, runId: string): string {
    assertRunId(runId)
    const runDir = path.join(stateDir, "runs", runId)
    assertInside(stateDir, runDir)
    return runDir
  }

  private artifactPaths(repositoryRoot: string, runDir: string): DelegateResult["artifacts"] {
    return {
      metadata: relativePath(repositoryRoot, path.join(runDir, "run.json")),
      report: relativePath(repositoryRoot, path.join(runDir, "report.json")),
      events: relativePath(repositoryRoot, path.join(runDir, "events.jsonl")),
      reasoning: relativePath(repositoryRoot, path.join(runDir, "reasoning.md")),
      stderr: relativePath(repositoryRoot, path.join(runDir, "stderr.log")),
      prompt: relativePath(repositoryRoot, path.join(runDir, "prompt.md")),
    }
  }

  private async runWorker(input: {
    worktree: string
    runDir: string
    prompt: string
    maxMinutes: number
  }): Promise<CommandResult> {
    const provider = process.env.QWEN_PROVIDER ?? "qwen-local"
    const model = process.env.QWEN_MODEL ?? "Qwen/Qwen3.8-27B"
    const variant = process.env.QWEN_VARIANT ?? "xhigh"
    const baseURL = process.env.QWEN_BASE_URL ?? "http://127.0.0.1:8000/v1"
    const isolatedHome = path.join(input.runDir, "home")
    await mkdir(isolatedHome, { recursive: true })

    const config = {
      default_agent: "qwen-worker",
      share: "disabled",
      provider: {
        [provider]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local Qwen Worker",
          options: {
            baseURL,
            apiKey: process.env.QWEN_API_KEY ?? "local",
            timeout: false,
            chunkTimeout: 120_000,
          },
          models: {
            [model]: {
              name: model,
              reasoning: true,
              tool_call: true,
              interleaved: "reasoning_content",
            },
          },
        },
      },
      mcp: {
        "qwen-delegation": {
          type: "local",
          command: ["true"],
          enabled: false,
        },
      },
    }

    const environment = {
      ...safeBaseEnvironment(),
      HOME: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
      XDG_DATA_HOME: path.join(isolatedHome, ".local", "share"),
      XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
      XDG_STATE_HOME: path.join(isolatedHome, ".local", "state"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      QWEN_DELEGATION_CHILD: "1",
    }

    const command = [
      ...this.workerCommand,
      "run",
      "--dir",
      input.worktree,
      "--agent",
      "qwen-worker",
      "--model",
      `${provider}/${model}`,
      "--variant",
      variant,
      "--thinking",
      "--format",
      "json",
      "--auto",
      input.prompt,
    ]
    const result = await runCommand({
      command,
      cwd: input.worktree,
      env: environment,
      timeoutMs: input.maxMinutes * 60 * 1000,
      allowFailure: true,
    })
    await Bun.write(path.join(input.runDir, "events.jsonl"), result.stdout)
    await Bun.write(path.join(input.runDir, "stderr.log"), result.stderr)
    return result
  }

  private async captureDiff(worktree: string): Promise<{ patch: string; files: string[]; stat: string }> {
    await this.git(["add", "-N", "--all"], worktree, true)
    const patch = (await this.git(["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--"], worktree)).stdout
    const filesOutput = (await this.git(["diff", "--name-only", "HEAD", "--"], worktree)).stdout
    const stat = (await this.git(["diff", "--stat", "HEAD", "--"], worktree)).stdout.trim()
    await this.git(["reset", "--mixed"], worktree, true)
    return {
      patch,
      files: filesOutput.split(/\r?\n/).filter(Boolean),
      stat,
    }
  }

  private async patchPathForRun(runId: string): Promise<string> {
    assertRunId(runId)
    const stateDir = await this.stateDir()
    const metadata = await this.readMetadata(stateDir, runId)
    const patchPath = path.join(this.runDir(stateDir, runId), "changes.patch")
    if (!(await Bun.file(patchPath).exists()) || (metadata.patch_bytes ?? 0) === 0) {
      throw new Error(`Run ${runId} does not contain an applicable patch`)
    }
    return patchPath
  }

  private async readMetadata(stateDir: string, runId: string): Promise<RunMetadata> {
    const value = await readJson(path.join(this.runDir(stateDir, runId), "run.json"))
    if (!isRecord(value) || value.id !== runId || !WORKER_ROLES.includes(value.role as WorkerRole)) {
      throw new Error(`Run metadata is invalid for ${runId}`)
    }
    return value as RunMetadata
  }

  private async removeWorktree(repositoryRoot: string, worktree: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", worktree], repositoryRoot, true)
    await rm(worktree, { recursive: true, force: true })
    await this.git(["worktree", "prune"], repositoryRoot, true)
  }

  private async git(args: string[], cwd: string, allowFailure = false): Promise<CommandResult> {
    return runCommand({
      command: ["git", ...args],
      cwd,
      allowFailure,
      timeoutMs: 10 * 60 * 1000,
    })
  }

  private toDelegateResult(metadata: RunMetadata): DelegateResult {
    const report = metadata.report ?? {
      status: "failed",
      summary: "Run metadata contains no worker report",
      files: [],
      commands: [],
      risks: ["Missing worker report"],
      next_steps: [],
      confidence: 0,
    }
    return {
      run_id: metadata.id,
      role: metadata.role,
      status: report.status,
      summary: report.summary,
      confidence: report.confidence,
      files: metadata.files_changed ?? report.files,
      commands: report.commands,
      risks: report.risks,
      next_steps: report.next_steps,
      patch_available: (metadata.patch_bytes ?? 0) > 0,
      patch_bytes: metadata.patch_bytes ?? 0,
      patch_stat: metadata.patch_stat ?? "",
      artifacts: metadata.artifacts,
    }
  }
}
