#!/usr/bin/env node

import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, "server.mjs")
const args = process.argv.slice(2)
const mcpOnly = args.includes("--mcp-only")

function argument(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

const baseURL = argument("--base-url", process.env.QWEN_BASE_URL || "http://127.0.0.1:12434/v1").replace(/\/$/, "")
const model = argument("--model", process.env.QWEN_MODEL_ID || "qwen3.8-27b")
const apiKey = argument("--api-key", process.env.QWEN_API_KEY || "local")

function pass(message) {
  process.stdout.write(`PASS  ${message}\n`)
}

function fail(message) {
  process.stderr.write(`FAIL  ${message}\n`)
  process.exitCode = 1
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once("exit", resolve))
}

async function checkMCP() {
  const state = await mkdtemp(path.join(os.tmpdir(), "opencool-hierarchy-doctor-"))
  const child = spawn(process.execPath, [server], {
    cwd: process.cwd(),
    env: { ...process.env, OPENCODE_ORCHESTRATOR_STATE_DIR: state },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let buffer = ""
  let stderr = ""
  const responses = new Map()
  const waiters = new Map()

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf("\n")
      if (newline === -1) break
      const raw = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!raw) continue
      let message
      try {
        message = JSON.parse(raw)
      } catch (error) {
        for (const reject of waiters.values()) reject(error)
        waiters.clear()
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(message, "id")) continue
      responses.set(message.id, message)
      const waiter = waiters.get(message.id)
      if (!waiter) continue
      waiters.delete(message.id)
      waiter(message)
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })

  function request(id, method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  }

  function waitFor(id) {
    const existing = responses.get(id)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`request ${id} timed out${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
      }, 5_000)
      waiters.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message)
      })
    })
  }

  try {
    request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "doctor", version: "1" },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`)
    request(2, "tools/list", {})

    const [initialized, listed] = await Promise.all([waitFor(1), waitFor(2)])
    if (initialized.result?.serverInfo?.name !== "opencool-hierarchical-orchestrator") {
      throw new Error("unexpected initialize response")
    }
    const names = listed.result?.tools?.map((tool) => tool.name) || []
    if (!names.includes("orchestrator_plan") || !names.includes("orchestrator_gate")) {
      throw new Error(`missing expected tools: ${names.join(", ")}`)
    }
    pass(`MCP handshake and ${names.length} orchestration tools`)
  } finally {
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await waitForExit(child)
    await rm(state, { recursive: true, force: true })
  }
}

async function checkQwen() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(`${baseURL}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    const models = Array.isArray(body?.data) ? body.data.map((item) => item?.id).filter(Boolean) : []
    if (!models.includes(model)) {
      throw new Error(`served model ${JSON.stringify(model)} not found; available: ${models.join(", ") || "none"}`)
    }
    pass(`Qwen OpenAI-compatible endpoint ${baseURL} serves ${model}`)
  } finally {
    clearTimeout(timeout)
  }
}

const major = Number(process.versions.node.split(".")[0])
if (!Number.isFinite(major) || major < 20) fail(`Node.js 20+ is required; found ${process.version}`)
else pass(`Node.js ${process.version}`)

try {
  await checkMCP()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (!mcpOnly) {
  try {
    await checkQwen()
  } catch (error) {
    fail(`Qwen endpoint check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (process.exitCode) process.exit(process.exitCode)
