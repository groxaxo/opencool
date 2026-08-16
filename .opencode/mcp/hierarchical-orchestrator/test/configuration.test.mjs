import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const mcpRoot = path.resolve(here, "..")
const opencodeRoot = path.resolve(here, "../../..")

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
      } else if (char === "\n") output += char
      continue
    }
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
    } else if (char === "/" && next === "/") {
      lineComment = true
      index += 1
    } else if (char === "/" && next === "*") {
      blockComment = true
      index += 1
    } else output += char
  }
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

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once("exit", resolve))
}

test("project MCP bootstrap discovers the worktree root from a nested directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencool-hierarchy-config-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await execFileAsync("git", ["init", "-q"], { cwd: root })
  await mkdir(path.join(root, ".opencode", "mcp"), { recursive: true })
  await cp(mcpRoot, path.join(root, ".opencode", "mcp", "hierarchical-orchestrator"), { recursive: true })
  const nested = path.join(root, "packages", "example")
  await mkdir(nested, { recursive: true })

  const config = JSON.parse(
    stripTrailingCommas(stripJsonComments(await readFile(path.join(opencodeRoot, "opencode.jsonc"), "utf8"))),
  )
  const command = config.mcp.hierarchy.command
  const child = spawn(command[0], command.slice(1), {
    cwd: nested,
    env: { ...process.env, ...config.mcp.hierarchy.environment },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let output = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    output += chunk
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      })}\n`,
    )
    const deadline = Date.now() + 5_000
    while (!output.includes("\n") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(output.includes("\n"), `bootstrap did not respond: ${stderr}`)
    const message = JSON.parse(output.split("\n")[0])
    assert.equal(message.result.serverInfo.name, "opencool-hierarchical-orchestrator")
    assert.equal(message.result.protocolVersion, "2025-06-18")
  } finally {
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await waitForExit(child)
  }
})
