import { spawnSync } from "child_process"
import { dateFromTs, encodeDeletion, encodeMemory, parseLine } from "./format"
import type { Memory, MemoryEntry, MemoryStore } from "./format"

export interface GitStoreOptions {
  repoRoot: string
  branch?: string
  subdir?: string
}

const git = (args: string[], options?: { input?: string; cwd?: string }): { stdout: string; exitCode: number } => {
  const proc = spawnSync("git", args, {
    cwd: options?.cwd,
    input: options?.input !== undefined ? options.input : undefined,
    encoding: "utf8",
  })
  return {
    stdout: (proc.stdout ?? "").trimEnd(),
    exitCode: proc.status ?? 1,
  }
}

/** Git-backed MemoryStore using synchronous `spawnSync` git plumbing.
 *
 * All git operations are synchronous (`spawnSync`), which blocks the Node.js
 * event loop. For a plugin called once per agent response (typically <10 git
 * commands per turn), this is acceptable. If call frequency increases or the
 * memory store grows to hundreds of files, consider migrating to async
 * `spawn` with a queue. */
export class GitStore implements MemoryStore {
  readonly dir: string
  readonly branch: string
  private readonly subdir: string
  private readonly repoRoot: string

  constructor(options: GitStoreOptions) {
    this.repoRoot = options.repoRoot
    this.branch = `refs/${options.branch || "memory/agent"}`
    this.subdir = options.subdir || ".opencode/memory"
    this.dir = this.subdir
  }

  private g(args: string[], options?: { input?: string }): { stdout: string; exitCode: number } {
    return git(args, { ...options, cwd: this.repoRoot })
  }

  private readBranchFile(filepath: string): string | null {
    const { stdout, exitCode } = this.g(["show", `${this.branch}:${filepath}`])
    if (exitCode !== 0) return null
    return stdout
  }

  private writeContent(filepath: string, content: string, message: string): void {
    const normalizedContent = content.endsWith("\n") ? content : content + "\n"
    const blobResult = this.g(["hash-object", "-w", "--stdin"], { input: normalizedContent })
    const blobHash = blobResult.stdout.trim()

    this.g(["read-tree", this.branch])
    this.g(["update-index", "--add", "--cacheinfo", `100644,${blobHash},${filepath}`])

    const treeResult = this.g(["write-tree"])
    const treeHash = treeResult.stdout.trim()

    const parentResult = this.g(["rev-parse", "--verify", this.branch])
    const parentRef = parentResult.exitCode === 0 ? parentResult.stdout.trim() : null

    let commitHash: string
    if (parentRef) {
      const result = this.g(["commit-tree", treeHash, "-p", parentRef], { input: message })
      commitHash = result.stdout.trim()
    } else {
      const result = this.g(["commit-tree", treeHash], { input: message })
      commitHash = result.stdout.trim()
    }

    this.g(["update-ref", this.branch, commitHash])
    this.g(["read-tree", "HEAD"])
  }

  async ensureDir(): Promise<void> {
    const result = this.g(["rev-parse", "--git-dir"])
    if (result.exitCode !== 0) throw new Error(`Not a git repository: ${this.repoRoot}`)

    const refResult = this.g(["rev-parse", "--verify", this.branch])
    if (refResult.exitCode !== 0) {
      this.g(["read-tree", "--empty"])
      const emptyTree = this.g(["write-tree"])
      this.g(["read-tree", "HEAD"])
      const init = this.g(["commit-tree", emptyTree.stdout.trim()], { input: "init memory store" })
      this.g(["update-ref", this.branch, init.stdout.trim()])
    }
  }

  async appendMemory(memory: Memory): Promise<void> {
    if (memory.content.length > 100_000) throw new Error("Memory content exceeds 100KB limit")
    if (memory.content.includes("\0")) throw new Error("Memory content contains null bytes")

    this.ensureDir()
    const filename = `${dateFromTs(memory.ts)}.logfmt`
    const filepath = `${this.subdir}/${filename}`
    const line = `${encodeMemory(memory)}\n`

    const existing = this.readBranchFile(filepath)
    const newContent = existing ? existing + line : line

    this.writeContent(filepath, newContent, `memory: add ${memory.type}/${memory.scope}`)
  }

  async appendDeletion(memory: Memory, reason: string): Promise<void> {
    this.ensureDir()
    const filepath = `${this.subdir}/deletions.logfmt`
    const line = `${encodeDeletion(memory, reason)}\n`

    const existing = this.readBranchFile(filepath)
    const newContent = existing ? existing + line : line

    this.writeContent(filepath, newContent, `memory: delete ${memory.type}/${memory.scope}`)
  }

  async readEntries(): Promise<MemoryEntry[]> {
    this.ensureDir()

    const prefix = `${this.subdir}/`
    const result = this.g(["ls-tree", "-r", "--name-only", this.branch])
    if (result.exitCode !== 0 || !result.stdout) return []

    const files = result.stdout
      .split("\n")
      .filter((f) => f.startsWith(prefix) && f.endsWith(".logfmt") && !f.endsWith("/deletions.logfmt"))
      .sort()

    const entries: MemoryEntry[] = []
    for (const filepath of files) {
      const content = this.readBranchFile(filepath)
      if (!content) continue
      const lines = content.split("\n")
      lines.forEach((line, lineIndex) => {
        const memory = parseLine(line)
        if (memory) entries.push({ memory, filepath, lineIndex })
      })
    }

    return entries.sort((a, b) => a.memory.ts.localeCompare(b.memory.ts))
  }

  async readDeletionLines(): Promise<string[]> {
    const filepath = `${this.subdir}/deletions.logfmt`
    const content = this.readBranchFile(filepath)
    if (!content) return []
    return content.trim().split("\n").filter(Boolean)
  }

  async rewriteFile(filepath: string, lines: string[]): Promise<void> {
    const content = lines.length ? `${lines.join("\n")}\n` : ""
    this.writeContent(filepath, content, `memory: rewrite ${filepath}`)
  }

  async readFile(filepath: string): Promise<string | null> {
    return this.readBranchFile(filepath)
  }
}
