import { dateFromTs, encodeDeletion, encodeMemory, parseLine } from "./format"
import type { Memory, MemoryEntry, MemoryStore } from "./format"

export interface GitStoreOptions {
  repoRoot: string
  branch?: string
  subdir?: string
}

const git = async (args: string[], options?: { input?: string; cwd?: string }): Promise<{ stdout: string; exitCode: number }> => {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: options?.cwd,
    stdin: options?.input !== undefined ? Buffer.from(options.input) : "inherit",
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    stdout: proc.stdout.toString().trimEnd(),
    exitCode: proc.exitCode,
  }
}

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

  private g(args: string[], options?: { input?: string }): Promise<{ stdout: string; exitCode: number }> {
    return git(args, { ...options, cwd: this.repoRoot })
  }

  private async readBranchFile(filepath: string): Promise<string | null> {
    const { stdout, exitCode } = await this.g(["show", `${this.branch}:${filepath}`])
    if (exitCode !== 0) return null
    return stdout
  }

  private async writeContent(filepath: string, content: string, message: string): Promise<void> {
    const normalizedContent = content.endsWith("\n") ? content : content + "\n"
    const blobResult = await this.g(["hash-object", "-w", "--stdin"], { input: normalizedContent })
    const blobHash = blobResult.stdout.trim()

    const indexPath = `/tmp/git-idx-${crypto.randomUUID()}`
    try {
      await this.g(["read-tree", this.branch])
      await this.g(["update-index", "--add", "--cacheinfo", `100644,${blobHash},${filepath}`])

      const treeResult = await this.g(["write-tree"])
      const treeHash = treeResult.stdout.trim()

      const parentResult = await this.g(["rev-parse", "--verify", this.branch])
      const parentRef = parentResult.exitCode === 0 ? parentResult.stdout.trim() : null

      let commitHash: string
      if (parentRef) {
        const result = await this.g(["commit-tree", treeHash, "-p", parentRef], { input: message })
        commitHash = result.stdout.trim()
      } else {
        const result = await this.g(["commit-tree", treeHash], { input: message })
        commitHash = result.stdout.trim()
      }

      await this.g(["update-ref", this.branch, commitHash])
    } finally {
      await Bun.$`rm -f ${indexPath}`.nothrow().quiet()
    }
  }

  async ensureDir(): Promise<void> {
    const result = await this.g(["rev-parse", "--git-dir"])
    if (result.exitCode !== 0) throw new Error(`Not a git repository: ${this.repoRoot}`)

    const refResult = await this.g(["rev-parse", "--verify", this.branch])
    if (refResult.exitCode !== 0) {
      await this.g(["read-tree", "--empty"])
      const emptyTree = await this.g(["write-tree"])
      const sanitizedIndex = await this.g(["read-tree", "HEAD"])
      const init = await this.g(["commit-tree", emptyTree.stdout.trim()], { input: "init memory store" })
      await this.g(["update-ref", this.branch, init.stdout.trim()])
    }
  }

  async appendMemory(memory: Memory): Promise<void> {
    await this.ensureDir()
    const filename = `${dateFromTs(memory.ts)}.logfmt`
    const filepath = `${this.subdir}/${filename}`
    const line = `${encodeMemory(memory)}\n`

    const existing = await this.readBranchFile(filepath)
    const newContent = existing ? existing + line : line

    await this.writeContent(filepath, newContent, `memory: add ${memory.type}/${memory.scope}`)
  }

  async appendDeletion(memory: Memory, reason: string): Promise<void> {
    await this.ensureDir()
    const filepath = `${this.subdir}/deletions.logfmt`
    const line = `${encodeDeletion(memory, reason)}\n`

    const existing = await this.readBranchFile(filepath)
    const newContent = existing ? existing + line : line

    await this.writeContent(filepath, newContent, `memory: delete ${memory.type}/${memory.scope}`)
  }

  async readEntries(): Promise<MemoryEntry[]> {
    await this.ensureDir()

    const prefix = `${this.subdir}/`
    const result = await this.g(["ls-tree", "-r", "--name-only", this.branch])
    if (result.exitCode !== 0 || !result.stdout) return []

    const files = result.stdout
      .split("\n")
      .filter((f) => f.startsWith(prefix) && f.endsWith(".logfmt") && !f.endsWith("/deletions.logfmt"))
      .sort()

    const entries: MemoryEntry[] = []
    for (const filepath of files) {
      const content = await this.readBranchFile(filepath)
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
    const content = await this.readBranchFile(filepath)
    if (!content) return []
    return content.trim().split("\n").filter(Boolean)
  }

  async rewriteFile(filepath: string, lines: string[]): Promise<void> {
    const content = lines.length ? `${lines.join("\n")}\n` : ""
    await this.writeContent(filepath, content, `memory: rewrite ${filepath}`)
  }

  async readFile(filepath: string): Promise<string | null> {
    return await this.readBranchFile(filepath)
  }
}
