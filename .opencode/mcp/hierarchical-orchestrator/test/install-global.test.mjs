import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const installer = path.resolve(here, "../install-global.mjs")

async function withTempConfig(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencool-hierarchy-install-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function runInstaller(configDir, extra = [], installerPath = installer) {
  const stateHome = path.join(configDir, "state-home")
  return execFileAsync(
    process.execPath,
    [
      installerPath,
      "--config-dir",
      configDir,
      "--base-url",
      "http://127.0.0.1:9876/v1",
      "--served-model",
      "vendor/qwen-worker",
      ...extra,
    ],
    {
      env: { ...process.env, OPENCODE_ORCHESTRATOR_STATE_HOME: stateHome },
    },
  )
}

test("global installer preserves existing config and installs runnable hierarchy components", async (t) => {
  const configDir = await withTempConfig(t)
  const configFile = path.join(configDir, "opencode.jsonc")
  await writeFile(
    configFile,
    `{
      // Existing user settings must survive.
      "$schema": "https://opencode.ai/config.json",
      "theme": "https://example.invalid/theme//dark",
      "experimental": {
        "primary_tools": ["existing_tool"],
      },
    }\n`,
    "utf8",
  )

  const installed = await runInstaller(configDir)
  assert.match(installed.stdout, /Installed OpenCool hierarchical orchestration globally/)

  const config = JSON.parse(await readFile(configFile, "utf8"))
  assert.equal(config.theme, "https://example.invalid/theme//dark")
  assert.equal(config.default_agent, "architect")
  assert.equal(config.subagent_depth, 1)
  assert.equal(config.provider["qwen-local"].options.baseURL, "http://127.0.0.1:9876/v1")
  assert.equal(config.provider["qwen-local"].models["qwen3.8-27b"].id, "vendor/qwen-worker")
  assert.equal(config.provider["qwen-local"].models["qwen3.8-27b"].interleaved, "reasoning_content")
  assert.deepEqual(
    config.experimental.primary_tools.filter((tool) => tool === "hierarchy_orchestrator_gate"),
    ["hierarchy_orchestrator_gate"],
  )
  assert.ok(config.experimental.primary_tools.includes("existing_tool"))

  const targetMcp = path.join(configDir, "mcp", "hierarchical-orchestrator")
  assert.equal(config.mcp.hierarchy.command[0], process.execPath)
  assert.equal(config.mcp.hierarchy.command[1], path.join(targetMcp, "server.mjs"))
  assert.equal(config.mcp.hierarchy.environment.OPENCODE_ORCHESTRATOR_STATE_HOME, path.join(configDir, "state-home"))

  await access(path.join(configDir, "agents", "architect.md"))
  await access(path.join(configDir, "agents", "qwen-worker.md"))
  await access(path.join(configDir, "commands", "hierarchy.md"))
  await access(path.join(configDir, "skills", "hierarchical-orchestration", "SKILL.md"))
  await access(path.join(targetMcp, "server.mjs"))

  const backups = (await readdir(configDir)).filter((name) => name.startsWith("opencode.jsonc.backup-"))
  assert.equal(backups.length, 1)

  const doctor = await execFileAsync(process.execPath, [path.join(targetMcp, "doctor.mjs"), "--mcp-only"])
  assert.match(doctor.stdout, /MCP handshake and 6 orchestration tools/)
})

test("global installer is idempotent and can preserve an existing default agent", async (t) => {
  const configDir = await withTempConfig(t)
  const configFile = path.join(configDir, "opencode.json")
  await writeFile(
    configFile,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        default_agent: "build",
        subagent_depth: 3,
        experimental: { primary_tools: ["hierarchy_orchestrator_gate"] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  await runInstaller(configDir, ["--no-default"])
  const installedInstaller = path.join(configDir, "mcp", "hierarchical-orchestrator", "install-global.mjs")
  const second = await execFileAsync(
    process.execPath,
    [
      installedInstaller,
      "--config-dir",
      configDir,
      "--base-url",
      "http://127.0.0.1:9876/v1",
      "--served-model",
      "vendor/qwen-worker",
      "--no-default",
    ],
    { env: { ...process.env, OPENCODE_ORCHESTRATOR_STATE_HOME: path.join(configDir, "state-home") } },
  )
  assert.match(second.stdout, /Config: .* \(unchanged\)/)

  const config = JSON.parse(await readFile(configFile, "utf8"))
  assert.equal(config.default_agent, "build")
  assert.equal(config.subagent_depth, 3)
  assert.equal(
    config.experimental.primary_tools.filter((tool) => tool === "hierarchy_orchestrator_gate").length,
    1,
  )
  assert.equal(config.provider["qwen-local"].models["qwen3.8-27b"].id, "vendor/qwen-worker")
  const backups = (await readdir(configDir)).filter((name) => name.startsWith("opencode.json.backup-"))
  assert.equal(backups.length, 1)
})


test("global installer copies only hierarchy-owned agents and commands", async (t) => {
  const root = await withTempConfig(t)
  const sourceRoot = path.join(root, "source", ".opencode")
  const originalSourceRoot = path.resolve(here, "../../../")
  await mkdir(path.dirname(sourceRoot), { recursive: true })
  await cp(originalSourceRoot, sourceRoot, { recursive: true })
  await writeFile(path.join(sourceRoot, "agent", "unrelated-agent.md"), "---\nmode: subagent\n---\nunrelated\n", "utf8")
  await writeFile(path.join(sourceRoot, "command", "unrelated-command.md"), "---\ndescription: unrelated\n---\nunrelated\n", "utf8")

  const configDir = path.join(root, "config")
  const fixtureInstaller = path.join(sourceRoot, "mcp", "hierarchical-orchestrator", "install-global.mjs")
  await runInstaller(configDir, [], fixtureInstaller)

  const agents = await readdir(path.join(configDir, "agents"))
  const commands = await readdir(path.join(configDir, "commands"))
  assert.ok(agents.includes("architect.md"))
  assert.ok(agents.includes("qwen-worker.md"))
  assert.ok(!agents.includes("unrelated-agent.md"))
  assert.deepEqual(commands, ["hierarchy.md"])
})
