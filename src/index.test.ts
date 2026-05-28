import { spawnSync } from "child_process"
import { randomUUID } from "crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { describe, it, beforeEach, afterEach } from "node:test"
import { strict as assert } from "node:assert"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MemoryPlugin } from "../index"

const tempRoot = join(fileURLToPath(new URL("..", import.meta.url)), ".tmp-tests")
let testDir = ""

const context = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  abort: new AbortController().signal,
}

const git = (args: string[], dir: string, input?: string): { stdout: string; stderr: string; exitCode: number } => {
  const proc = spawnSync("git", args, {
    cwd: dir,
    input: input ?? undefined,
    encoding: "utf8",
  })
  return {
    stdout: (proc.stdout ?? "").toString(),
    stderr: (proc.stderr ?? "").toString(),
    exitCode: proc.status ?? 1,
  }
}

const initRepo = async (dir: string) => {
  await mkdir(dir, { recursive: true })
  git(["init"], dir)
  git(["config", "user.email", "test@test.com"], dir)
  git(["config", "user.name", "test"], dir)
  await writeFile(join(dir, ".gitignore"), ".opencode/\n")
  git(["add", ".gitignore"], dir)
  git(["commit", "-m", "init"], dir, "init")
}

const ensureMemoryBranch = (dir: string) => {
  const { exitCode } = git(["rev-parse", "--verify", "refs/memory/agent"], dir)
  if (exitCode === 0) return
  git(["read-tree", "--empty"], dir)
  const { stdout: emptyTree } = git(["write-tree"], dir)
  const { stdout: commitHash } = git(["commit-tree", emptyTree.trim()], dir, "init")
  git(["update-ref", "refs/memory/agent", commitHash.trim()], dir)
}

const writeMemoryFile = (dir: string, filename: string, lines: string[]) => {
  ensureMemoryBranch(dir)
  const filepath = `.opencode/memory/${filename}`
  const content = lines.join("\n") + "\n"
  const ref = "refs/memory/agent"

  const { stdout: blobHash } = git(["hash-object", "-w", "--stdin"], dir, content)
  git(["read-tree", ref], dir)
  git(["update-index", "--add", "--cacheinfo", `100644,${blobHash.trim()},${filepath}`], dir)
  const { stdout: treeHash } = git(["write-tree"], dir)
  const { stdout: parentHash } = git(["rev-parse", ref], dir)
  const { stdout: commitHash } = git(["commit-tree", treeHash.trim(), "-p", parentHash.trim()], dir, "test memory data")
  git(["update-ref", ref, commitHash.trim()], dir)
}

const readMemoryFile = (dir: string, filename: string): string => {
  const { stdout, exitCode } = git(["show", `refs/memory/agent:.opencode/memory/${filename}`], dir)
  if (exitCode !== 0) return ""
  return stdout
}

const loadTools = async () => {
  const plugin = await MemoryPlugin({ directory: testDir } as never)
  if (!plugin.tool) throw new Error("Plugin did not return tools")
  const recall = plugin.tool.memory_recall
  const remember = plugin.tool.memory_remember
  const exportMemories = plugin.tool.memory_export
  const importMemories = plugin.tool.memory_import
  const forget = plugin.tool.memory_forget
  const compact = plugin.tool.memory_compact
  const memoryContext = plugin.tool.memory_context
  if (!recall || !remember || !exportMemories || !importMemories || !forget || !compact || !memoryContext) {
    throw new Error("Plugin did not return all tools")
  }
  return { recall, remember, exportMemories, importMemories, forget, compact, memoryContext }
}

describe("memory_recall", () => {
  beforeEach(async () => {
    testDir = join(tempRoot, randomUUID())
    await initRepo(testDir)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it("returns the highest scoring query matches within the limit", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="api only"',
      'ts=2026-05-28T10:01:00.000Z type=context scope=database content="api only"',
      'ts=2026-05-28T10:02:00.000Z type=decision scope=api content="api decision"',
    ])

    const tools = await loadTools()
    const output = await tools.recall.execute({ query: "api", limit: 2 }, context)

    assert.ok(output.includes("[2026-05-28] decision/api: api decision"))
    assert.ok(output.includes("[2026-05-28] context/api: api only"))
    assert.ok(!output.includes("context/database"))
  })

  it("returns the latest chronological memories when no query is provided", async () => {
    writeMemoryFile(testDir, "2026-05-27.logfmt", ['ts=2026-05-27T10:00:00.000Z type=context scope=old content="old memory"'])
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=first content="first new memory"',
      'ts=2026-05-28T11:00:00.000Z type=context scope=second content="second new memory"',
    ])

    const tools = await loadTools()
    const output = await tools.recall.execute({ limit: 2 }, context)

    assert.ok(output.includes("[2026-05-28] context/first: first new memory"))
    assert.ok(output.includes("[2026-05-28] context/second: second new memory"))
    assert.ok(!output.includes("old memory"))
  })

  it("round-trips multiline content written by memory_remember", async () => {
    const tools = await loadTools()
    await tools.remember.execute(
      {
        type: "context",
        scope: "notes",
        content: "line one\nline two with \"quotes\" and \\ slash",
      },
      context,
    )

    const output = await tools.recall.execute({ scope: "notes", match: "exact" }, context)
    const date = new Date().toISOString().split("T")[0]!
    const raw = readMemoryFile(testDir, `${date}.logfmt`)

    assert.ok(output.includes("line one\nline two with \"quotes\" and \\ slash"))
    assert.ok(raw.includes('content="line one\\nline two with \\"quotes\\" and \\\\ slash"'))
  })

  it("imports compatible logfmt records with escaped multiline content", async () => {
    const tools = await loadTools()
    await tools.importMemories.execute(
      {
        format: "logfmt",
        data: 'ts=2026-05-28T12:00:00.000Z type=context scope=imported content="first\\nsecond"',
      },
      context,
    )

    const output = await tools.recall.execute({ scope: "imported", match: "exact" }, context)
    const exported = await tools.exportMemories.execute({ format: "jsonl" }, context)

    assert.ok(output.includes("first\nsecond"))
    assert.equal(JSON.parse(exported).content, "first\nsecond")
  })

  it("preserves raw backslashes from older compatible records", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", ['ts=2026-05-28T10:00:00.000Z type=context scope=paths content="C:\\tmp\\memory"'])

    const tools = await loadTools()
    const output = await tools.recall.execute({ scope: "paths", match: "exact" }, context)

    assert.ok(output.includes("C:\\tmp\\memory"))
  })

  it("filters by tags, date range, and exact scope matching", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="old api" tags=backend,stale',
      'ts=2026-05-28T11:00:00.000Z type=context scope=api-v2 content="new api v2" tags=backend,current',
      'ts=2026-05-28T12:00:00.000Z type=context scope=api content="new api" tags=backend,current',
    ])

    const tools = await loadTools()
    const output = await tools.recall.execute(
      { scope: "api", match: "exact", tags: ["current"], since: "2026-05-28T11:30:00.000Z", until: "2026-05-28" },
      context,
    )

    assert.ok(output.includes("new api"))
    assert.ok(!output.includes("old api"))
    assert.ok(!output.includes("api-v2"))
  })

  it("memory_forget with query deletes only the best matching memory", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="keep postgres detail"',
      'ts=2026-05-28T11:00:00.000Z type=context scope=api content="delete redis detail"',
    ])

    const tools = await loadTools()
    const deleted = await tools.forget.execute({ type: "context", scope: "api", reason: "test", query: "redis" }, context)
    const output = await tools.recall.execute({ scope: "api", match: "exact" }, context)

    assert.ok(deleted.includes("Deleted 1 context memory(s)"))
    assert.ok(output.includes("keep postgres detail"))
    assert.ok(!output.includes("delete redis detail"))
  })

  it("memory_export and memory_import round-trip json", async () => {
    const tools = await loadTools()
    await tools.remember.execute({ type: "pattern", scope: "tests", content: "use plugin interface", tags: ["testing"] }, context)

    const exported = await tools.exportMemories.execute({ format: "json" }, context)

    git(["update-ref", "-d", "refs/memory/agent"], testDir)

    const imported = await tools.importMemories.execute({ format: "json", data: exported }, context)
    const output = await tools.recall.execute({ scope: "tests", match: "exact" }, context)

    assert.equal(imported, "Imported 1 memory(s)")
    assert.ok(output.includes("pattern/tests: use plugin interface [testing]"))
  })

  it("memory_compact removes exact duplicate records", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="duplicate"',
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="duplicate"',
    ])

    const tools = await loadTools()
    const dryRun = await tools.compact.execute({ dryRun: true }, context)
    const compacted = await tools.compact.execute({}, context)
    const output = await tools.recall.execute({}, context)

    assert.ok(dryRun.includes("1 duplicate(s) removed"))
    assert.ok(compacted.includes("1 duplicate(s) removed"))
    assert.ok(output.includes("Found 1 memories"))
  })

  it("memory_context returns a compact relevant memory pack", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy',
      'ts=2026-05-28T11:00:00.000Z type=context scope=tests content="Run make staging-live-onboarding-e2e for staging onboarding" tags=staging,e2e',
      'ts=2026-05-28T12:00:00.000Z type=context scope=runtime/local content="Local Bifrost is available through host.docker.internal" tags=local',
    ])

    const tools = await loadTools()
    const output = await tools.memoryContext.execute({ query: "staging deploy", limit: 2, maxChars: 220 }, context)

    assert.ok(output.includes("RM:"))
    assert.ok(output.includes("deploy/staging"))
    assert.ok(output.includes("tests"))
    assert.ok(!output.includes("runtime/local"))
  })

  it("automatic hooks are disabled by default", async () => {
    const plugin = await MemoryPlugin({ directory: testDir } as never)
    if (!plugin["chat.message"] || !plugin["experimental.chat.system.transform"] || !plugin.tool?.memory_recall) throw new Error("Plugin did not return hooks/tools")

    writeMemoryFile(testDir, "2026-05-28.logfmt", ['ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy'])

    await plugin["chat.message"](
      { sessionID: "session-1", agent: "build", model: { providerID: "test", modelID: "test" } },
      {
        message: {} as never,
        parts: [{ type: "text", text: "remember that I prefer minimal diffs and how do I restart staging deployments?" }] as never,
      },
    )

    const system = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]({}, system)

    const output = await plugin.tool.memory_recall.execute({ scope: "user", match: "exact" }, context)

    assert.ok(output.includes("No matching memories"))
    assert.deepEqual(system.system, [])
  })

  it("auto-save stores explicit remember requests when enabled", async () => {
    const plugin = await MemoryPlugin({ directory: testDir } as never, { autoSave: true })
    if (!plugin["chat.message"] || !plugin.tool?.memory_recall) throw new Error("Plugin did not return hooks/tools")

    await plugin["chat.message"](
      { sessionID: "session-1", agent: "build", model: { providerID: "test", modelID: "test" } },
      {
        message: {} as never,
        parts: [{ type: "text", text: "remember that I prefer minimal diffs" }] as never,
      },
    )

    const output = await plugin.tool.memory_recall.execute({ scope: "user", match: "exact" }, context)

    assert.ok(output.includes("preference/user: I prefer minimal diffs [auto]"))
  })

  it("auto-load injects relevant memories into system context when enabled", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", ['ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy'])
    const plugin = await MemoryPlugin({ directory: testDir } as never, { autoLoad: true })
    if (!plugin["chat.message"] || !plugin["experimental.chat.system.transform"]) throw new Error("Plugin did not return auto hooks")

    await plugin["chat.message"](
      { sessionID: "session-1", agent: "build", model: { providerID: "test", modelID: "test" } },
      {
        message: {} as never,
        parts: [{ type: "text", text: "how do I restart staging deployments?" }] as never,
      },
    )

    const output = { system: [] as string[] }
    await plugin["experimental.chat.system.transform"]({}, output)

    assert.ok(output.system.join("\n").includes("RM:"))
    assert.ok(output.system.join("\n").includes("deploy/staging"))
  })
})
