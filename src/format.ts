export const MEMORY_TYPES = ["decision", "learning", "preference", "blocker", "context", "pattern"] as const

export type MemoryType = typeof MEMORY_TYPES[number]

export interface Memory {
  ts: string
  type: MemoryType
  scope: string
  content: string
  issue?: string
  tags?: string[]
}

export interface MemoryEntry {
  memory: Memory
  filepath: string
  lineIndex: number
}

export interface MemoryStore {
  dir: string
  branch: string
  ensureDir(): Promise<void>
  appendMemory(memory: Memory): Promise<void>
  appendDeletion(memory: Memory, reason: string): Promise<void>
  readEntries(): Promise<MemoryEntry[]>
  readDeletionLines(): Promise<string[]>
  rewriteFile(filepath: string, lines: string[]): Promise<void>
  readFile(filepath: string): Promise<string | null>
}

export const isMemoryType = (value: string): value is MemoryType => MEMORY_TYPES.includes(value as MemoryType)

export const dateFromTs = (ts: string) => ts.split("T")[0] || new Date().toISOString().split("T")[0]!

const escapeValue = (value: string) => value
  .replace(/\\/g, "\\\\")
  .replace(/\n/g, "\\n")
  .replace(/\r/g, "\\r")
  .replace(/"/g, '\\"')

const unescapeValue = (value: string) => {
  let result = ""
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char !== "\\") {
      result += char
      continue
    }
    const next = value[++i]
    if (next === "n") result += "\n"
    else if (next === "r") result += "\r"
    else if (next === '"') result += '"'
    else if (next === "\\") result += "\\"
    else if (next !== undefined) result += `\\${next}`
  }
  return result
}

const needsQuotes = (value: string) => value === "" || /\s|"|\\/.test(value)

export const field = (key: string, value: string, alwaysQuote = false) => {
  if (!alwaysQuote && !needsQuotes(value)) return `${key}=${value}`
  return `${key}="${escapeValue(value)}"`
}

export const parseFields = (line: string): Record<string, string> => {
  const fields: Record<string, string> = {}
  let index = 0

  while (index < line.length) {
    while (line[index] === " ") index++

    const keyStart = index
    while (index < line.length && line[index] !== "=" && line[index] !== " ") index++
    const key = line.slice(keyStart, index)
    if (!key || line[index] !== "=") break
    index++

    if (line[index] === '"') {
      index++
      let value = ""
      while (index < line.length) {
        const char = line[index]
        if (char === '"') {
          index++
          break
        }
        if (char === "\\" && index + 1 < line.length) {
          value += char + line[index + 1]
          index += 2
          continue
        }
        value += char
        index++
      }
      fields[key] = unescapeValue(value)
      continue
    }

    const valueStart = index
    while (index < line.length && line[index] !== " ") index++
    fields[key] = line.slice(valueStart, index)
  }

  return fields
}

export const parseLine = (line: string): Memory | null => {
  const fields = parseFields(line)
  const { ts, type, scope } = fields
  if (!ts || !type || !scope || !isMemoryType(type)) return null
  return {
    ts,
    type,
    scope,
    content: fields.content || "",
    issue: fields.issue,
    tags: fields.tags ? fields.tags.split(",").filter(Boolean) : undefined,
  }
}

export const encodeMemory = (memory: Memory): string => {
  const parts = [
    field("ts", memory.ts),
    field("type", memory.type),
    field("scope", memory.scope),
    field("content", memory.content, true),
  ]
  if (memory.issue) parts.push(field("issue", memory.issue))
  if (memory.tags?.length) parts.push(field("tags", memory.tags.join(",")))
  return parts.join(" ")
}

export const encodeDeletion = (memory: Memory, reason: string): string => {
  const parts = [
    field("ts", new Date().toISOString()),
    field("action", "deleted"),
    field("original_ts", memory.ts),
    field("type", memory.type),
    field("scope", memory.scope),
    field("content", memory.content, true),
    field("reason", reason, true),
  ]
  if (memory.issue) parts.push(field("issue", memory.issue))
  if (memory.tags?.length) parts.push(field("tags", memory.tags.join(",")))
  return parts.join(" ")
}

export const formatMemory = (memory: Memory): string => {
  const date = dateFromTs(memory.ts)
  const tags = memory.tags?.length ? ` [${memory.tags.join(", ")}]` : ""
  const issue = memory.issue ? ` (${memory.issue})` : ""
  return `[${date}] ${memory.type}/${memory.scope}: ${memory.content}${issue}${tags}`
}

export const scoreMatch = (memory: Memory, words: string[]): number => {
  const searchable = `${memory.type} ${memory.scope} ${memory.content} ${memory.tags?.join(" ") || ""}`.toLowerCase()
  let score = 0
  for (const word of words) {
    if (searchable.includes(word)) score++
    if (memory.scope.toLowerCase() === word) score += 2
    if (memory.type.toLowerCase() === word) score += 2
    if (memory.tags?.some((tag) => tag.toLowerCase() === word)) score += 2
  }
  return score
}

export const typePriority: Record<MemoryType, number> = {
  preference: 6,
  decision: 5,
  blocker: 4,
  pattern: 3,
  context: 2,
  learning: 1,
}

export const truncate = (value: string, maxLength: number) => {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

export const matchesScope = (memory: Memory, scope: string, mode: "contains" | "exact" | "prefix") => {
  if (mode === "exact") return memory.scope === scope
  if (mode === "prefix") return memory.scope.startsWith(scope)
  return memory.scope === scope || memory.scope.includes(scope)
}

const startOfDateFilter = (value: string) => value.includes("T") ? value : `${value}T00:00:00.000Z`
const endOfDateFilter = (value: string) => value.includes("T") ? value : `${value}T23:59:59.999Z`

interface MemoryFilters {
  scope?: string
  scopeMatch?: "contains" | "exact" | "prefix"
  type?: MemoryType | readonly MemoryType[]
  tags?: string[]
  since?: string
  until?: string
}

const applyFilters = (memories: Memory[], filters: MemoryFilters): Memory[] => {
  let results = memories
  const scopeMatch = filters.scopeMatch || "contains"

  if (filters.scope) {
    const s = filters.scope
    results = results.filter((memory) => matchesScope(memory, s, scopeMatch))
  }
  if (filters.type) {
    const types = Array.isArray(filters.type) ? filters.type : [filters.type]
    results = results.filter((memory) => (types as readonly MemoryType[]).includes(memory.type))
  }
  if (filters.tags?.length) {
    const tags = filters.tags.map((tag) => tag.toLowerCase())
    results = results.filter((memory) => {
      const memoryTags = memory.tags?.map((tag) => tag.toLowerCase()) || []
      return tags.every((tag) => memoryTags.includes(tag))
    })
  }
  if (filters.since) {
    const since = startOfDateFilter(filters.since)
    results = results.filter((memory) => memory.ts >= since)
  }
  if (filters.until) {
    const until = endOfDateFilter(filters.until)
    results = results.filter((memory) => memory.ts <= until)
  }

  return results
}

export const filterMemories = (memories: Memory[], args: {
  scope?: string
  type?: MemoryType
  query?: string
  tags?: string[]
  since?: string
  until?: string
  match?: "contains" | "exact" | "prefix"
}) => {
  const results = applyFilters(memories, {
    scope: args.scope,
    scopeMatch: args.match,
    type: args.type,
    tags: args.tags,
    since: args.since,
    until: args.until,
  })

  if (!args.query) return results

  const words = args.query.toLowerCase().split(/\s+/).filter(Boolean)
  return results
    .map((memory) => ({ memory, score: scoreMatch(memory, words) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.ts.localeCompare(a.memory.ts))
    .map((item) => item.memory)
}

export const buildContextPack = (memories: Memory[], options: {
  query?: string
  scope?: string
  tags?: string[]
  types?: MemoryType[]
  limit?: number
  maxChars?: number
  minScore?: number
}) => {
  const query = options.query?.trim()
  const words = query?.toLowerCase().split(/\s+/).filter(Boolean) || []
  const minScore = options.minScore ?? (query ? 1 : 0)
  const maxChars = options.maxChars && options.maxChars > 0 ? Math.floor(options.maxChars) : 1200
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 5

  const results = applyFilters(memories, {
    scope: options.scope,
    type: options.types,
    tags: options.tags,
  })

  const ranked = results
    .map((memory) => ({
      memory,
      score: words.length ? scoreMatch(memory, words) : 0,
    }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => {
      const priority = typePriority[b.memory.type] - typePriority[a.memory.type]
      return b.score - a.score || priority || b.memory.ts.localeCompare(a.memory.ts)
    })
    .slice(0, limit)

  if (!ranked.length) return ""

  const lines = ["Relevant Memory:"]
  let used = lines[0]!.length + 1

  for (const { memory } of ranked) {
    const prefix = `- ${memory.type}/${memory.scope}: `
    const remaining = maxChars - used - prefix.length
    if (remaining <= 20) break

    const line = `${prefix}${truncate(memory.content, Math.min(remaining, 260))}`
    lines.push(line)
    used += line.length + 1
  }

  return lines.length > 1 ? lines.join("\n") : ""
}

export const chooseUpdateTarget = (matches: MemoryEntry[], query?: string): { target?: MemoryEntry; message?: string } => {
  if (matches.length <= 1) return { target: matches[0], message: undefined }
  if (!query) {
    return {
      target: undefined,
      message: `Found ${matches.length} memories for ${matches[0]!.memory.type}/${matches[0]!.memory.scope}. Provide a query to select which one to update, or use recall to see all matches.`,
    }
  }

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const scored = matches
    .map((entry) => ({ ...entry, score: scoreMatch(entry.memory, words) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.ts.localeCompare(a.memory.ts))

  if (!scored.length) {
    return {
      target: undefined,
      message: `Found ${matches.length} memories for ${matches[0]!.memory.type}/${matches[0]!.memory.scope}, but none matched query "${query}". Use recall to see all matches.`,
    }
  }

  return { target: scored[0], message: undefined }
}

export const textFromParts = (parts: unknown[]) => parts
  .map((part) => {
    if (typeof part !== "object" || !part) return ""
    if (!("type" in part) || part.type !== "text") return ""
    if (!("text" in part) || typeof part.text !== "string") return ""
    return part.text
  })
  .filter(Boolean)
  .join("\n")
  .trim()

export const inferExplicitMemory = (text: string, defaultScope: string): Omit<Memory, "ts"> | null => {
  if (/\b(don't|do not|dont)\s+remember\b/i.test(text)) return null

  const match = text.match(/(?:^|\b)(?:please\s+)?remember(?:\s+that|:)?\s+([\s\S]+)$/i)
  const content = match?.[1]?.trim()
  if (!content) return null

  const lower = content.toLowerCase()
  const type: MemoryType = lower.includes("prefer")
    ? "preference"
    : lower.includes("decided") || lower.includes("decision")
      ? "decision"
      : lower.includes("blocked") || lower.includes("blocker")
        ? "blocker"
        : lower.includes("pattern") || lower.includes("always")
          ? "pattern"
          : "context"

  return {
    type,
    scope: defaultScope,
    content,
    tags: ["auto"],
  }
}

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
