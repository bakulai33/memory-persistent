import { mkdir, readdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { BUILD, SCHEMA_VERSION } from "./build.js"
import { emptyConsolidation, recoverStaleAttempt } from "./consolidation.js"
import type { Consolidation } from "./consolidation.js"

export interface MemoryNote {
  id: string
  text: string
  tags: string[]
  createdAt: string
  source: "manual" | "auto"
}

export interface PendingTurn {
  turnId: string
  messageID: string
  userExcerpt: string
  createdAt: string
}

/** Tool activity worth remembering: a file that changed, a meaningful command, or an error. */
export interface ActivityEntry {
  id: string
  kind: "file" | "command" | "error"
  target: string
  count: number
  turnID?: string
  createdAt: string
}

export interface MemoryFile {
  version: typeof SCHEMA_VERSION
  sessionID: string
  parentSnapshotFrom: string | null
  build: string
  summary: string
  summaryFacts: string
  summaryNarrative: string
  notes: MemoryNote[]
  pendingTurns: PendingTurn[]
  pendingActivity: ActivityEntry[]
  needsConsolidation: boolean
  consolidation: Consolidation
  updatedAt: string
}

/** A file found in the memory directory. `corrupt` files are backups of a file that failed to parse. */
export interface MemoryFileEntry {
  readonly id: string
  readonly kind: "memory" | "corrupt"
  readonly file: string
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

/** Validates a session id and keeps its brand, so it still fits the OpenCode session types. */
export function sanitizeSessionID<T extends string>(sessionID: T): T {
  if (!SESSION_ID_RE.test(sessionID)) throw new Error(`Invalid sessionID: ${sessionID}`)
  return sessionID
}

export function dataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".local", "share")
  return join(base, "opencode")
}

export function memoryDir(): string {
  return join(dataRoot(), "memory-persistent", "sessions")
}

export function memoryPath(sessionID: string): string {
  const id = sanitizeSessionID(sessionID)
  return join(memoryDir(), `${id}.json`)
}

const locks = new Map<string, Promise<void>>()

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  locks.set(key, prev.then(() => next))
  try {
    await prev
    return await fn()
  } finally {
    resolve()
    if (locks.get(key) === next) locks.delete(key)
  }
}

export function emptyMemory(sessionID: string, parentSnapshotFrom: string | null = null): MemoryFile {
  const now = new Date().toISOString()
  return {
    version: SCHEMA_VERSION,
    sessionID,
    parentSnapshotFrom,
    build: BUILD,
    summary: "",
    summaryFacts: "",
    summaryNarrative: "",
    notes: [],
    pendingTurns: [],
    pendingActivity: [],
    needsConsolidation: false,
    consolidation: emptyConsolidation(),
    updatedAt: now,
  }
}

export async function readMemory(sessionID: string): Promise<MemoryFile> {
  const id = sanitizeSessionID(sessionID)
  const path = memoryPath(id)
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as MemoryFile | MemoryFileV1 | MemoryFileV2
    if (parsed.sessionID !== id) throw new Error("bad schema")
    let memory: MemoryFile
    if (parsed.version === 1) {
      memory = migrateV1(parsed as MemoryFileV1)
    } else if (parsed.version === 2) {
      memory = migrateV2(parsed as MemoryFileV2)
    } else if (parsed.version === SCHEMA_VERSION) {
      memory = {
        ...parsed,
        build: parsed.build ?? BUILD,
        summary: parsed.summary ?? "",
        summaryFacts: parsed.summaryFacts ?? "",
        summaryNarrative: parsed.summaryNarrative ?? "",
        notes: parsed.notes ?? [],
        pendingTurns: parsed.pendingTurns ?? [],
        pendingActivity: parsed.pendingActivity ?? [],
        consolidation: parsed.consolidation ?? emptyConsolidation(),
      }
    } else {
      throw new Error("bad schema")
    }
    recoverStaleAttempt(memory)
    return memory
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyMemory(id)
    // corrupt recovery: keep the unreadable file aside instead of losing it
    try {
      const backup = `${path}.corrupt.${Date.now()}`
      await rename(path, backup).catch(() => {})
    } catch {}
    return emptyMemory(id)
  }
}

export async function writeMemory(sessionID: string, memory: MemoryFile): Promise<void> {
  const id = sanitizeSessionID(sessionID)
  if (isDeleted(id)) return
  const path = memoryPath(id)
  memory.sessionID = id
  memory.updatedAt = new Date().toISOString()
  await mkdir(dirname(path), { recursive: true })
  await withLock(id, async () => {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
    await writeFile(tmp, JSON.stringify(memory, null, 2), { encoding: "utf8", mode: 0o600 })
    await rename(tmp, path)
    try {
      await chmod(path, 0o600)
    } catch {}
  })
}

export async function copyMemory(fromSessionID: string, toSessionID: string): Promise<void> {
  const from = await readMemory(fromSessionID)
  const copy = { ...from, sessionID: toSessionID, parentSnapshotFrom: fromSessionID, updatedAt: new Date().toISOString() }
  await writeMemory(toSessionID, copy)
}

/** Removes the memory file of a session and any corrupt backups left beside it. */
export async function deleteMemoryFiles(sessionID: string): Promise<void> {
  const id = sanitizeSessionID(sessionID)
  const dir = memoryDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  const targets = entries.filter((entry) => entry === `${id}.json` || entry.startsWith(`${id}.json.corrupt.`))
  for (const target of targets) {
    try {
      await rm(join(dir, target), { force: true })
    } catch {}
  }
}

/** Lists the memory files on disk, including the corrupt backups that a failed parse left behind. */
export async function listMemoryFiles(): Promise<MemoryFileEntry[]> {
  const dir = memoryDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const result: MemoryFileEntry[] = []
  for (const entry of entries) {
    if (entry.endsWith(".json")) {
      result.push({ id: entry.slice(0, -".json".length), kind: "memory", file: entry })
      continue
    }
    const marker = ".json.corrupt."
    const index = entry.indexOf(marker)
    if (index === -1) continue
    result.push({ id: entry.slice(0, index), kind: "corrupt", file: entry })
  }
  return result
}

// Deleted sessions are remembered so a late write cannot recreate their file.
const DELETED_LIMIT = 256
const deletedSessions = new Map<string, true>()

export function markDeleted(sessionID: string): void {
  const id = sanitizeSessionID(sessionID)
  deletedSessions.delete(id)
  deletedSessions.set(id, true)
  while (deletedSessions.size > DELETED_LIMIT) {
    const oldest = deletedSessions.keys().next()
    if (oldest.done) break
    deletedSessions.delete(oldest.value)
  }
}

export function isDeleted(sessionID: string): boolean {
  return deletedSessions.has(sessionID)
}

export function capPendingTurns(turns: PendingTurn[], max = 20): PendingTurn[] {
  if (turns.length <= max) return turns
  return turns.slice(turns.length - max)
}

export function capActivity(entries: ActivityEntry[], max = 40): ActivityEntry[] {
  if (entries.length <= max) return entries
  return entries.slice(entries.length - max)
}

/**
 * Records tool activity, folding repeats of the same target into a count.
 * Returns the entry when it was new, so callers can mark the session dirty.
 */
export function addActivity(memory: MemoryFile, entry: Omit<ActivityEntry, "id" | "count" | "createdAt"> & { id?: string }): boolean {
  const existing = memory.pendingActivity.find((item) => item.kind === entry.kind && item.target === entry.target)
  if (existing) {
    existing.count += 1
    if (!existing.turnID && entry.turnID) existing.turnID = entry.turnID
    memory.needsConsolidation = true
    return false
  }
  const created: ActivityEntry = {
    id: entry.id ?? randomUUID(),
    kind: entry.kind,
    target: entry.target,
    count: 1,
    turnID: entry.turnID,
    createdAt: new Date().toISOString(),
  }
  memory.pendingActivity = capActivity([...memory.pendingActivity, created])
  memory.needsConsolidation = true
  return true
}

export interface MemoryFileV2 {
  version: 2
  sessionID: string
  parentSnapshotFrom: string | null
  summary: string
  notes: MemoryNote[]
  pendingTurns: PendingTurn[]
  pendingActivity: ActivityEntry[]
  needsConsolidation: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastFailure: string | null
  failureCount: number
  updatedAt: string
}

export interface MemoryFileV1 {
  version: 1
  sessionID: string
  [key: string]: unknown
  parentSnapshotFrom: string | null
  summary: string
  notes: MemoryNote[]
  pendingTurns: {
    turnId: string
    messageID: string
    userExcerpt: string
    touchedFiles: string[]
    errors: string[]
    createdAt: string
  }[]
  needsConsolidation: boolean
  lastAttemptAt: string | null
  updatedAt: string
}

const V1_TOOL_PREFIX = /^(shell|bash|edit|write|patch|apply_patch|multiedit): /

/**
 * Converts a v1 memory file to v2: conversation quotes stay, tool-derived turns become
 * activity entries, and the trivial tool noise is dropped.
 */
export function migrateV2(v2: MemoryFileV2): MemoryFile {
  const summary = v2.summary ?? ""
  const consolidation = emptyConsolidation()
  consolidation.lastAttemptAt = v2.lastAttemptAt ?? null
  consolidation.consecutiveFailures = v2.failureCount ?? 0
  consolidation.error = v2.lastFailure ?? null
  consolidation.state = v2.lastFailure ? "failed" : "idle"
  return {
    version: SCHEMA_VERSION,
    sessionID: v2.sessionID,
    parentSnapshotFrom: v2.parentSnapshotFrom,
    build: "0.3.0",
    summary,
    summaryFacts: summary,
    summaryNarrative: "",
    notes: v2.notes ?? [],
    pendingTurns: v2.pendingTurns ?? [],
    pendingActivity: v2.pendingActivity ?? [],
    needsConsolidation: v2.needsConsolidation ?? false,
    consolidation,
    updatedAt: v2.updatedAt ?? new Date().toISOString(),
  }
}

export function migrateV1(v1: MemoryFileV1): MemoryFile {
  const migrated: MemoryFileV2 = {
    version: 2,
    sessionID: v1.sessionID,
    parentSnapshotFrom: v1.parentSnapshotFrom,
    summary: v1.summary ?? "",
    notes: v1.notes ?? [],
    pendingTurns: [],
    pendingActivity: [],
    needsConsolidation: v1.needsConsolidation ?? false,
    lastAttemptAt: v1.lastAttemptAt ?? null,
    lastSuccessAt: null,
    lastFailure: null,
    failureCount: 0,
    updatedAt: v1.updatedAt ?? new Date().toISOString(),
  }

  for (const turn of v1.pendingTurns ?? []) {
    const excerpt = turn.userExcerpt ?? ""
    if (!V1_TOOL_PREFIX.test(excerpt)) {
      migrated.pendingTurns = capPendingTurns([
        ...migrated.pendingTurns,
        {
          turnId: turn.turnId,
          messageID: turn.messageID,
          userExcerpt: excerpt,
          createdAt: turn.createdAt ?? migrated.updatedAt,
        },
      ])
      continue
    }
    const separator = excerpt.indexOf(": ")
    const tool = separator === -1 ? "" : excerpt.slice(0, separator)
    const target = separator === -1 ? "" : excerpt.slice(separator + 2)
    if (!target) continue
    if (V1_FILE_TOOLS.has(tool)) {
      addActivity(migrated as any, { kind: "file", target })
      continue
    }
    if (V1_SHELL_TOOLS.has(tool) && V1_ALLOWED_COMMANDS.has(target)) {
      addActivity(migrated as any, { kind: "command", target })
    }
  }

  return migrateV2(migrated)
}

const V1_FILE_TOOLS = new Set(["write", "edit", "patch", "apply_patch", "multiedit"])
const V1_SHELL_TOOLS = new Set(["shell", "bash"])
// Kept in sync with SHELL_ALLOW in metadata.ts; a v1 excerpt only holds the first token.
const V1_ALLOWED_COMMANDS = new Set([
  "git", "bun", "npm", "pnpm", "yarn", "node", "deno", "make", "cmake", "cargo", "go",
  "gradle", "mvn", "tsc", "jest", "vitest", "pytest", "ruff", "mypy", "eslint", "prettier",
  "black", "pip", "pip3", "poetry", "uv", "docker", "docker-compose", "kubectl", "terraform",
  "psql", "mysql", "curl", "wget", "ssh", "scp", "rsync", "rm", "mv", "cp", "mkdir", "touch",
  "chmod", "systemctl", "brew", "apt", "gcc", "clang", "python", "python3",
])
