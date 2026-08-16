#!/usr/bin/env node

import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(here, "../..")
const args = process.argv.slice(2)

function hasFlag(name) {
  return args.includes(name)
}

function option(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function printHelp() {
  process.stdout.write(`OpenCool hierarchical orchestration global installer\n\n`)
  process.stdout.write(`Usage:\n`)
  process.stdout.write(`  node install-global.mjs [options]\n\n`)
  process.stdout.write(`Options:\n`)
  process.stdout.write(`  --config-dir PATH       OpenCode config directory (default: ~/.config/opencode)\n`)
  process.stdout.write(`  --base-url URL          Qwen OpenAI-compatible base URL\n`)
  process.stdout.write(`  --served-model ID       Model ID exposed by /v1/models\n`)
  process.stdout.write(`  --api-key VALUE         API key sent to the local endpoint (default: local)\n`)
  process.stdout.write(`  --no-default            Install architect without making it the global default agent\n`)
  process.stdout.write(`  --dry-run               Print the planned destinations without writing\n`)
  process.stdout.write(`  --help                  Show this help\n`)
}

if (hasFlag("--help")) {
  printHelp()
  process.exit(0)
}

const configDir = path.resolve(
  option(
    "--config-dir",
    process.env.OPENCODE_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode"),
  ),
)
const baseURL = option("--base-url", process.env.QWEN_BASE_URL || "http://127.0.0.1:12434/v1").replace(/\/$/, "")
const servedModel = option("--served-model", process.env.QWEN_MODEL_ID || "qwen3.8-27b")
const apiKey = option("--api-key", process.env.QWEN_API_KEY || "local")
const noDefault = hasFlag("--no-default")
const dryRun = hasFlag("--dry-run")
const stateHome = path.resolve(
  process.env.OPENCODE_ORCHESTRATOR_STATE_HOME ||
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode", "hierarchy"),
)

function stripJsonComments(input) {
  let output = ""
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (lineComment) {
      if (char === "\n") {
        lineComment = false
        output += char
      }
      continue
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index += 1
        continue
      }
      if (char === "\n") output += "\n"
      continue
    }

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    output += char
  }

  if (blockComment) throw new Error("unterminated block comment in OpenCode config")
  return output
}

function stripTrailingCommas(input) {
  let output = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ",") {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead])) lookahead += 1
      if (input[lookahead] === "}" || input[lookahead] === "]") continue
    }
    output += char
  }
  return output
}

function parseJsonc(text, filename) {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)))
  } catch (error) {
    throw new Error(`cannot parse ${filename}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function mergeUnique(existing, values) {
  return [...new Set([...(Array.isArray(existing) ? existing : []), ...values])]
}

function hierarchyConfig(targetMcp) {
  const primaryTools = [
    "hierarchy_orchestrator_plan",
    "hierarchy_orchestrator_packet",
    "hierarchy_orchestrator_record",
    "hierarchy_orchestrator_status",
    "hierarchy_orchestrator_gate",
    "hierarchy_orchestrator_close",
  ]

  return {
    provider: {
      "qwen-local": {
        name: "Qwen Local",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL,
          apiKey,
          timeout: false,
          chunkTimeout: 120000,
        },
        models: {
          "qwen3.8-27b": {
            id: servedModel,
            name: "Qwen3.8 27B — Local Worker",
            reasoning: true,
            temperature: true,
            tool_call: true,
            interleaved: "reasoning_content",
            limit: { context: 262144, output: 32768 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    mcp: {
      hierarchy: {
        type: "local",
        command: [process.execPath, path.join(targetMcp, "server.mjs")],
        cwd: ".",
        environment: {
          OPENCODE_ORCHESTRATOR_STATE_HOME: stateHome,
        },
        enabled: true,
        timeout: 15000,
      },
    },
    primaryTools,
  }
}

async function selectConfigFile() {
  const jsonc = path.join(configDir, "opencode.jsonc")
  const json = path.join(configDir, "opencode.json")
  if (await exists(jsonc)) return jsonc
  if (await exists(json)) return json
  return json
}

async function sourcePath(...candidates) {
  for (const candidate of candidates) {
    const target = path.join(sourceRoot, candidate)
    if (await exists(target)) return target
  }
  throw new Error(`cannot find installer source under ${sourceRoot}: ${candidates.join(" or ")}`)
}

async function copyOne(source, target) {
  if (path.resolve(source) === path.resolve(target)) return
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, force: true })
}

async function copyComponents(targetMcp) {
  const agentFiles = [
    "architect.md",
    "qwen-explorer.md",
    "qwen-worker.md",
    "qwen-tester.md",
    "qwen-critic.md",
    "qwen-synthesizer.md",
  ]
  for (const filename of agentFiles) {
    const source = await sourcePath(path.join("agent", filename), path.join("agents", filename))
    await copyOne(source, path.join(configDir, "agents", filename))
  }

  await copyOne(
    await sourcePath(path.join("command", "hierarchy.md"), path.join("commands", "hierarchy.md")),
    path.join(configDir, "commands", "hierarchy.md"),
  )
  await copyOne(
    await sourcePath(path.join("skills", "hierarchical-orchestration")),
    path.join(configDir, "skills", "hierarchical-orchestration"),
  )

  if (path.resolve(here) !== path.resolve(targetMcp)) {
    await rm(targetMcp, { recursive: true, force: true })
    await mkdir(path.dirname(targetMcp), { recursive: true })
    await cp(here, targetMcp, { recursive: true, force: true })
  }
}

async function updateConfig(configFile, targetMcp) {
  let config = {}
  let original
  if (await exists(configFile)) {
    original = await readFile(configFile, "utf8")
    config = parseJsonc(original, configFile)
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error(`${configFile} must contain a JSON object`)
    }
  }

  const defaults = hierarchyConfig(targetMcp)
  config.$schema ||= "https://opencode.ai/config.json"
  config.provider ||= {}
  config.provider["qwen-local"] = {
    ...(config.provider["qwen-local"] || {}),
    ...defaults.provider["qwen-local"],
    options: {
      ...(config.provider["qwen-local"]?.options || {}),
      ...defaults.provider["qwen-local"].options,
    },
    models: {
      ...(config.provider["qwen-local"]?.models || {}),
      "qwen3.8-27b": {
        ...(config.provider["qwen-local"]?.models?.["qwen3.8-27b"] || {}),
        ...defaults.provider["qwen-local"].models["qwen3.8-27b"],
      },
    },
  }
  config.mcp ||= {}
  config.mcp.hierarchy = defaults.mcp.hierarchy
  config.subagent_depth = Math.max(Number(config.subagent_depth) || 0, 1)
  if (!noDefault) config.default_agent = "architect"
  config.experimental ||= {}
  config.experimental.primary_tools = mergeUnique(config.experimental.primary_tools, defaults.primaryTools)

  await mkdir(configDir, { recursive: true })
  const next = `${JSON.stringify(config, null, 2)}\n`
  if (original === next) return { config, changed: false, backup: undefined }

  let backup
  if (original !== undefined) {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
    backup = `${configFile}.backup-${stamp}`
    await writeFile(backup, original, "utf8")
  }
  const temporary = `${configFile}.${process.pid}.tmp`
  await writeFile(temporary, next, "utf8")
  await rename(temporary, configFile)
  return { config, changed: true, backup }
}

const targetMcp = path.join(configDir, "mcp", "hierarchical-orchestrator")
const configFile = await selectConfigFile()

const plan = {
  config_dir: configDir,
  config_file: configFile,
  agents_dir: path.join(configDir, "agents"),
  commands_dir: path.join(configDir, "commands"),
  skill_dir: path.join(configDir, "skills", "hierarchical-orchestration"),
  mcp_dir: targetMcp,
  state_home: stateHome,
  qwen_base_url: baseURL,
  served_model: servedModel,
  default_agent: noDefault ? "unchanged" : "architect",
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ dry_run: true, ...plan }, null, 2)}\n`)
  process.exit(0)
}

await copyComponents(targetMcp)
const update = await updateConfig(configFile, targetMcp)

process.stdout.write(`Installed OpenCool hierarchical orchestration globally.\n`)
process.stdout.write(`Config: ${configFile}${update.changed ? " (updated)" : " (unchanged)"}\n`)
if (update.backup) process.stdout.write(`Config backup: ${update.backup}\n`)
process.stdout.write(`Agents: ${plan.agents_dir}\n`)
process.stdout.write(`Skill: ${plan.skill_dir}\n`)
process.stdout.write(`MCP: ${targetMcp}\n`)
process.stdout.write(`Qwen: ${baseURL} -> ${servedModel}\n`)
process.stdout.write(`State: ${stateHome}/<workspace-hash>\n`)
process.stdout.write(`\nVerify:\n`)
process.stdout.write(`  ${process.execPath} ${path.join(targetMcp, "doctor.mjs")} --mcp-only\n`)
process.stdout.write(`  ${process.execPath} ${path.join(targetMcp, "doctor.mjs")} --base-url ${baseURL} --model ${servedModel}\n`)
process.stdout.write(`\nUse the selected frontier model normally; the architect agent does not pin the primary model.\n`)
