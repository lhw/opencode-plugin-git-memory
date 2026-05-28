import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { MemoryPlugin } from "../index"

const tempRoot = join(import.meta.dir, "..", ".tmp-tests")
let testDir = ""

const context = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  abort: new AbortController().signal,
}

const git = (args: string[], dir: string, input?: string): { stdout: string; stderr: string; exitCode: number } => {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdin: input !== undefined ? Buffer.from(input) : "inherit",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  }
}

const initRepo = async (dir: string) => {
  await mkdir(dir, { recursive: true })
  git(["init"], dir)
  git(["config", "user.email", "test@test.com"], dir)
  git(["config", "user.name", "test"], dir)
  await Bun.write(join(dir, ".gitignore"), ".opencode/\n")
  git(["add", ".gitignore"], dir)
  git(["commit", "-m", "init"], dir, "init")
}

const emptyTreeHash = (dir: string): string => {
  const idx = `/tmp/empty-tree-${crypto.randomUUID()}`
  git(["read-tree", "--empty"], dir)
  const { stdout } = git(["write-tree"], dir)
  return stdout.trim()
}

const ensureMemoryBranch = (dir: string) => {
  const { exitCode } = git(["rev-parse", "--verify", "refs/memory/agent"], dir)
  if (exitCode === 0) return
  const tree = emptyTreeHash(dir)
  const { stdout } = git(["commit-tree", tree], dir, "init")
  const commitHash = stdout.trim()
  git(["update-ref", "refs/memory/agent", commitHash], dir)
}

const writeMemoryFile = (dir: string, filename: string, lines: string[]) => {
  ensureMemoryBranch(dir)
  const filepath = `.opencode/memory/${filename}`
  const content = lines.join("\n") + "\n"
  const ref = "refs/memory/agent"

  const { stdout: blobOut } = git(["hash-object", "-w", "--stdin"], dir, content)
  const blobHash = blobOut.trim()

  const idxFile = `/tmp/test-idx-${crypto.randomUUID()}`
  git(["read-tree", ref], dir)
  git(["update-index", "--add", "--cacheinfo", `100644,${blobHash},${filepath}`], dir)
  const { stdout: treeOut } = git(["write-tree"], dir)
  const treeHash = treeOut.trim()

  const { stdout: parentOut } = git(["rev-parse", ref], dir)
  const parentHash = parentOut.trim()
  const { stdout: commitOut } = git(["commit-tree", treeHash, "-p", parentHash], dir, "test memory data")
  const commitHash = commitOut.trim()
  git(["update-ref", ref, commitHash], dir)
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
  if (!recall) throw new Error("Plugin did not return memory_recall")
  if (!remember) throw new Error("Plugin did not return memory_remember")
  if (!exportMemories) throw new Error("Plugin did not return memory_export")
  if (!importMemories) throw new Error("Plugin did not return memory_import")
  if (!forget) throw new Error("Plugin did not return memory_forget")
  if (!compact) throw new Error("Plugin did not return memory_compact")
  if (!memoryContext) throw new Error("Plugin did not return memory_context")
  return { recall, remember, exportMemories, importMemories, forget, compact, memoryContext }
}

beforeEach(async () => {
  testDir = join(tempRoot, crypto.randomUUID())
  await initRepo(testDir)
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe("memory_recall", () => {
  test("returns the highest scoring query matches within the limit", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="api only"',
      'ts=2026-05-28T10:01:00.000Z type=context scope=database content="api only"',
      'ts=2026-05-28T10:02:00.000Z type=decision scope=api content="api decision"',
    ])

    const tools = await loadTools()
    const output = await tools.recall.execute({ query: "api", limit: 2 }, context)

    expect(output).toContain("[2026-05-28] decision/api: api decision")
    expect(output).toContain("[2026-05-28] context/api: api only")
    expect(output).not.toContain("context/database")
  })

  test("returns the latest chronological memories when no query is provided", async () => {
    writeMemoryFile(testDir, "2026-05-27.logfmt", ['ts=2026-05-27T10:00:00.000Z type=context scope=old content="old memory"'])
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=first content="first new memory"',
      'ts=2026-05-28T11:00:00.000Z type=context scope=second content="second new memory"',
    ])

    const tools = await loadTools()
    const output = await tools.recall.execute({ limit: 2 }, context)

    expect(output).toContain("[2026-05-28] context/first: first new memory")
    expect(output).toContain("[2026-05-28] context/second: second new memory")
    expect(output).not.toContain("old memory")
  })

  test("round-trips multiline content written by memory_remember", async () => {
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

    expect(output).toContain("line one\nline two with \"quotes\" and \\ slash")
    expect(raw).toContain('content="line one\\nline two with \\"quotes\\" and \\\\ slash"')
  })

  test("imports compatible logfmt records with escaped multiline content", async () => {
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

    expect(output).toContain("first\nsecond")
    expect(JSON.parse(exported).content).toBe("first\nsecond")
  })

  test("preserves raw backslashes from older compatible records", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", ['ts=2026-05-28T10:00:00.000Z type=context scope=paths content="C:\\tmp\\memory"'])

    const tools = await loadTools()
    const output = await tools.recall.execute({ scope: "paths", match: "exact" }, context)

    expect(output).toContain("C:\\tmp\\memory")
  })

  test("filters by tags, date range, and exact scope matching", async () => {
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

    expect(output).toContain("new api")
    expect(output).not.toContain("old api")
    expect(output).not.toContain("api-v2")
  })

  test("memory_forget with query deletes only the best matching memory", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="keep postgres detail"',
      'ts=2026-05-28T11:00:00.000Z type=context scope=api content="delete redis detail"',
    ])

    const tools = await loadTools()
    const deleted = await tools.forget.execute({ type: "context", scope: "api", reason: "test", query: "redis" }, context)
    const output = await tools.recall.execute({ scope: "api", match: "exact" }, context)

    expect(deleted).toContain("Deleted 1 context memory(s)")
    expect(output).toContain("keep postgres detail")
    expect(output).not.toContain("delete redis detail")
  })

  test("memory_export and memory_import round-trip json", async () => {
    const tools = await loadTools()
    await tools.remember.execute({ type: "pattern", scope: "tests", content: "use plugin interface", tags: ["testing"] }, context)

    const exported = await tools.exportMemories.execute({ format: "json" }, context)

    git(["update-ref", "-d", "refs/memory/agent"], testDir)

    const imported = await tools.importMemories.execute({ format: "json", data: exported }, context)
    const output = await tools.recall.execute({ scope: "tests", match: "exact" }, context)

    expect(imported).toBe("Imported 1 memory(s)")
    expect(output).toContain("pattern/tests: use plugin interface [testing]")
  })

  test("memory_compact removes exact duplicate records", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="duplicate"',
      'ts=2026-05-28T10:00:00.000Z type=context scope=api content="duplicate"',
    ])

    const tools = await loadTools()
    const dryRun = await tools.compact.execute({ dryRun: true }, context)
    const compacted = await tools.compact.execute({}, context)
    const output = await tools.recall.execute({}, context)

    expect(dryRun).toContain("1 duplicate(s) removed")
    expect(compacted).toContain("1 duplicate(s) removed")
    expect(output).toContain("Found 1 memories")
  })

  test("memory_context returns a compact relevant memory pack", async () => {
    writeMemoryFile(testDir, "2026-05-28.logfmt", [
      'ts=2026-05-28T10:00:00.000Z type=context scope=deploy/staging content="Use materialize-deployments.cjs for staging runtime restart" tags=staging,deploy',
      'ts=2026-05-28T11:00:00.000Z type=context scope=tests content="Run make staging-live-onboarding-e2e for staging onboarding" tags=staging,e2e',
      'ts=2026-05-28T12:00:00.000Z type=context scope=runtime/local content="Local Bifrost is available through host.docker.internal" tags=local',
    ])

    const tools = await loadTools()
    const output = await tools.memoryContext.execute({ query: "staging deploy", limit: 2, maxChars: 220 }, context)

    expect(output).toContain("Relevant Memory:")
    expect(output).toContain("deploy/staging")
    expect(output).toContain("tests")
    expect(output).not.toContain("runtime/local")
  })

  test("automatic hooks are disabled by default", async () => {
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

    expect(output).toContain("No matching memories")
    expect(system.system).toEqual([])
  })

  test("auto-save stores explicit remember requests when enabled", async () => {
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

    expect(output).toContain("preference/user: I prefer minimal diffs [auto]")
  })

  test("auto-load injects relevant memories into system context when enabled", async () => {
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

    expect(output.system.join("\n")).toContain("Relevant Memory:")
    expect(output.system.join("\n")).toContain("deploy/staging")
  })
})
