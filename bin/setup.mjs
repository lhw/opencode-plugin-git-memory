#!/usr/bin/env node

import { intro, outro, select, confirm, isCancel, cancel, note, spinner } from "@clack/prompts"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

const PLUGIN_NAME = "opencode-plugin-git-memory"

const GLOBAL_CONFIG = join(process.env.HOME ?? process.env.USERPROFILE, ".config", "opencode", "opencode.json")
const PROJECT_CONFIG = join(process.cwd(), "opencode.json")

if (process.argv.includes("--uninstall")) {
  intro("Uninstall Git Memory Plugin")
  const s = spinner()
  s.start("Removing...")

  const removed = []
  for (const configPath of [PROJECT_CONFIG, GLOBAL_CONFIG]) {
    if (!existsSync(configPath)) continue
    try {
      const raw = await readFile(configPath, "utf-8")
      const config = JSON.parse(raw)
      const plugins = config.plugin
      if (!Array.isArray(plugins)) continue
      const idx = plugins.findIndex((p) => {
        if (typeof p === "string") return p === PLUGIN_NAME
        if (Array.isArray(p) && typeof p[0] === "string") return p[0] === PLUGIN_NAME
        return false
      })
      if (idx === -1) continue
      plugins.splice(idx, 1)
      if (plugins.length === 0) delete config.plugin
      await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
      removed.push(configPath)
    } catch {
      // skip unreadable configs
    }
  }

  s.stop("Removed")
  if (removed.length) {
    note(removed.join("\n"), "Updated configs")
    outro("Restart opencode — plugin is gone.")
  } else {
    outro("Plugin not found in any opencode config.")
  }
  process.exit(0)
}

intro("Git Memory Plugin for OpenCode")

const location = await select({
  message: "Where do you want to install?",
  options: [
    { value: "project", label: "This project", hint: "opencode.json" },
    { value: "global", label: "Global", hint: "~/.config/opencode/opencode.json" },
  ],
})
if (isCancel(location)) cancel("Setup cancelled")

const configPath = location === "global" ? GLOBAL_CONFIG : PROJECT_CONFIG

const autoLoad = await confirm({
  message: "Enable auto-load? (injects relevant memories before each response)",
  initialValue: true,
})
if (isCancel(autoLoad)) cancel("Setup cancelled")

const autoSave = await confirm({
  message: "Enable auto-save? (stores explicit 'remember that...' requests)",
  initialValue: true,
})
if (isCancel(autoSave)) cancel("Setup cancelled")

const s = spinner()
s.start("Configuring...")

try {
  let config = { plugin: [] }
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf-8")
      config = JSON.parse(raw)
    } catch {
      // start fresh if file is corrupt
    }
  }

  if (!Array.isArray(config.plugin)) config.plugin = []

  const exists = config.plugin.some((p) => {
    if (typeof p === "string") return p === PLUGIN_NAME
    if (Array.isArray(p) && typeof p[0] === "string") return p[0] === PLUGIN_NAME
    return false
  })

  if (!exists) {
    config.plugin.push([
      PLUGIN_NAME,
      {
        autoLoad,
        autoSave,
      },
    ])
  }

  await mkdir(join(configPath, ".."), { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")

  s.stop("Configured")
} catch (e) {
  s.stop("Failed")
  cancel(`Error: ${e.message}`)
}

note(configPath, "Updated config")

outro(
  "Restart opencode — memories will persist across sessions!\n" +
    "Run with --uninstall to remove.",
)
