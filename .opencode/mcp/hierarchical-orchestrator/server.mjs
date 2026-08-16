#!/usr/bin/env node

import crypto from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const directory = path.join(here, "server.parts")
const files = (await readdir(directory)).filter((file) => file.endsWith(".mjs.part")).sort()
if (files.length === 0) throw new Error(`No hierarchical orchestrator server parts found in ${directory}`)
const source = (await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8"))))
  .join("")
  .replace(/^#![^\n]*(?:\n|$)/, "")
const digest = crypto.createHash("sha256").update(source).digest("hex")
const assembled = path.join(os.tmpdir(), `opencool-hierarchical-orchestrator-${digest}.mjs`)
await writeFile(assembled, source, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch((error) => {
  if (error?.code !== "EEXIST") throw error
})
await import(pathToFileURL(assembled).href)
