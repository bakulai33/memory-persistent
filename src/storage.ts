import { mkdir, readdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { BUILD, SCHEMA_VERSION } from "./build.js"
import { emptyConsolidation, recoverStaleAttempt } from "./consolidation.js"
import type { Consolidation } from "./consolidation.js"
import type { CaptureTier } from "./capture.js"

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
  /** Capture tier of the prompt. A missing tier means the default tier, "likely". */
  tier?: CaptureTier
}

/** Tool activity worth remembering: a file that changed, a meaningful command, or an error. */
export interface ActivityEntry {
  id: string
  kind: "file" | "command" | "error"
  target: string
  command: string | null
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

/** The build record written on every activation, next to the sessions directory. */
export function buildInfoPath(): string {
  return join(dataRoot(), "memory-persistent", "build.json")
}

export function memoryPath(sessionID: string): string {
  const id = sanitizeSessionID(sessionID)
  return join(memoryDir(), `${id}.json`)
}

/** Where the plugin writes its structured log lines. Next to the sessions dir. */
export function logPath(): string {
  return join(dataRoot(), "memory-persistent", "plugin.log")
}

const locks = new Map<string, Promise<void>>()

/**
 * Serializes the work on one key.
 *
 * The lock is not reentrant: acquiring the same key while it is held waits
 * for the current holder to release it, so the holder must never call back
 * into the lock. `updateMemory` therefore writes through the unlocked writer
 * instead of through `writeMemory`.
 *
 * The map holds the chained promise of the acquisition, not the promise the
 * holder waits on, so the cleanup compares against the chain it installed.
 * Without that, one entry per session id would stay in the map for the
 * lifetime of the process.
 */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  const chain = prev.then(() => next)
  locks.set(key, chain)
  try {
    await prev
    return await fn()
  } finally {
    resolve()
    // The entry is dropped only while it still belongs to this chain: a later
    // acquisition for the same key owns the entry now and drops it itself.
    if (locks.get(key) === chain) locks.delete(key)
  }
}

/** The number of keys the lock map currently holds. Exposed so the tests can prove it is cleaned. */
export function lockCount(): number {
  return locks.size
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

function normalizeConsolidation(raw: unknown): Consolidation {
  const c = emptyConsolidation()
  if (!raw || typeof raw !== "object") return c
  const r = raw as Record<string, unknown>
  if (r.state === "running" || r.state === "failed") c.state = r.state
  c.attemptId = typeof r.attemptId === "string" ? r.attemptId : null
  c.startedAt = typeof r.startedAt === "string" ? r.startedAt : null
  c.finishedAt = typeof r.finishedAt === "string" ? r.finishedAt : null
  c.error = typeof r.error === "string" ? r.error : null
  c.consecutiveFailures =
    typeof r.consecutiveFailures === "number" && Number.isFinite(r.consecutiveFailures)
      ? r.consecutiveFailures
      : 0
  c.deferrals = typeof r.deferrals === "number" && Number.isFinite(r.deferrals) ? r.deferrals : 0
  c.deferredSince = typeof r.deferredSince === "string" ? r.deferredSince : null
  c.lastAttemptAt = typeof r.lastAttemptAt === "string" ? r.lastAttemptAt : null
  c.pendingSince = typeof r.pendingSince === "string" ? r.pendingSince : null
  c.consolidatedNotes =
    typeof r.consolidatedNotes === "number" && Number.isFinite(r.consolidatedNotes)
      ? r.consolidatedNotes
      : 0
  return c
}

/** The tiers a stored turn may carry. */
const CAPTURE_TIERS: CaptureTier[] = ["always", "likely", "noise"]

/** Files written before the capture tiers existed carry no tier; the default tier is "likely". */
function withTier(turn: PendingTurn): PendingTurn {
  const tier = turn.tier
  return { ...turn, tier: tier && CAPTURE_TIERS.includes(tier) ? tier : "likely" }
}

/** Normalizes a stored activity entry so files written before `command` existed still load. */
function normalizeActivityEntry(raw: unknown): ActivityEntry {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const kind = r.kind === "file" || r.kind === "command" || r.kind === "error" ? r.kind : "file"
  const target = typeof r.target === "string" ? r.target : ""
  const count = typeof r.count === "number" && Number.isFinite(r.count) ? r.count : 1
  const id = typeof r.id === "string" ? r.id : randomUUID()
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString()
  const turnID = typeof r.turnID === "string" ? r.turnID : undefined
  let command: string | null
  if (r.command === null) command = null
  else if (typeof r.command === "string") command = r.command
  else command = kind === "command" && target ? (target.split(/\s+/)[0] ?? null) : null
  return { id, kind, target, command, count, turnID, createdAt }
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
        pendingTurns: (parsed.pendingTurns ?? []).map(withTier),
        pendingActivity: (parsed.pendingActivity ?? []).map(normalizeActivityEntry),
        needsConsolidation: parsed.needsConsolidation === true,
        consolidation: normalizeConsolidation(parsed.consolidation),
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

async function writeMemoryUnlocked(sessionID: string, memory: MemoryFile): Promise<void> {
  const id = sanitizeSessionID(sessionID)
  if (isDeleted(id)) return
  const path = memoryPath(id)
  memory.sessionID = id
  memory.updatedAt = new Date().toISOString()
  // The build that last wrote the file is always the running build: a migration
  // is read-only and never stamps, so drift clears after the next real write.
  memory.build = BUILD
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`
  await writeFile(tmp, JSON.stringify(memory, null, 2), { encoding: "utf8", mode: 0o600 })
  await rename(tmp, path)
  try {
    await chmod(path, 0o600)
  } catch {}
}

export async function writeMemory(sessionID: string, memory: MemoryFile): Promise<void> {
  const id = sanitizeSessionID(sessionID)
  await withLock(id, async () => {
    await writeMemoryUnlocked(id, memory)
  })
}

export interface MemoryUpdate<T> {
  readonly memory: MemoryFile
  readonly value: T
}

export async function updateMemory<T>(
  sessionID: string,
  mutate: (m: MemoryFile) => T | Promise<T>,
): Promise<MemoryUpdate<T>> {
  const id = sanitizeSessionID(sessionID)
  return withLock(id, async () => {
    const m = await readMemory(id)
    const value = await mutate(m)
    await writeMemoryUnlocked(id, m)
    return { memory: m, value }
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
export async function repairPermissions(dir?: string): Promise<{ files: number; dirs: number }> {
  const target = dir ?? join(dataRoot(), "memory-persistent")
  let files = 0
  let dirs = 0

  // On a fresh install the standard directories may not exist yet; create them
  // so their permissions can be repaired (and enforced) at activation.
  if (dir === undefined) {
    const sessions = join(target, "sessions")
    await mkdir(target, { recursive: true }).catch(() => {})
    await mkdir(sessions, { recursive: true }).catch(() => {})
  }

  async function walk(current: string): Promise<void> {
    try {
      await chmod(current, 0o700)
      dirs += 1
    } catch {}
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          await chmod(full, 0o600)
          files += 1
        } catch {}
      }
    }
  }

  try {
    await walk(target)
  } catch {}
  return { files, dirs }
}

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
export function addActivity(memory: MemoryFile, entry: Omit<ActivityEntry, "id" | "count" | "createdAt" | "command"> & { id?: string; command?: string | null }): boolean {
  const inferredCommand =
    entry.command === undefined
      ? entry.kind === "command"
        ? (entry.target.split(/\s+/)[0] ?? null)
        : null
      : entry.command
  const command = inferredCommand
  const existing = memory.pendingActivity.find((item) => item.kind === entry.kind && item.target === entry.target)
  if (existing) {
    existing.count += 1
    if (!existing.turnID && entry.turnID) existing.turnID = entry.turnID
    if (existing.command == null && command != null) existing.command = command
    memory.needsConsolidation = true
    if (memory.consolidation && memory.consolidation.pendingSince == null) {
      memory.consolidation.pendingSince = new Date().toISOString()
    }
    return false
  }
  const created: ActivityEntry = {
    id: entry.id ?? randomUUID(),
    kind: entry.kind,
    target: entry.target,
    command,
    count: 1,
    turnID: entry.turnID,
    createdAt: new Date().toISOString(),
  }
  memory.pendingActivity = capActivity([...memory.pendingActivity, created])
  memory.needsConsolidation = true
  if (memory.consolidation && memory.consolidation.pendingSince == null) {
    memory.consolidation.pendingSince = new Date().toISOString()
  }
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
  consolidation.lastAttemptAt = typeof v2.lastAttemptAt === "string" ? v2.lastAttemptAt : null
  consolidation.consecutiveFailures = typeof v2.failureCount === "number" && Number.isFinite(v2.failureCount) ? v2.failureCount : 0
  consolidation.error = typeof v2.lastFailure === "string" ? v2.lastFailure : null
  consolidation.state = consolidation.error ? "failed" : "idle"
  return {
    version: SCHEMA_VERSION,
    sessionID: v2.sessionID,
    parentSnapshotFrom: v2.parentSnapshotFrom,
    build: "0.3.0",
    summary,
    summaryFacts: summary,
    summaryNarrative: "",
    notes: v2.notes ?? [],
    pendingTurns: (v2.pendingTurns ?? []).map(withTier),
    pendingActivity: (v2.pendingActivity ?? []).map(normalizeActivityEntry),
    needsConsolidation: v2.needsConsolidation === true,
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
    needsConsolidation: v1.needsConsolidation === true,
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
