import { mkdir, readdir, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { BUILD, SCHEMA_VERSION } from "./build.js"
import { dataRoot, logEvent } from "./log.js"
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
  summaryFactsInherited: string
  summaryNarrative: string
  notes: MemoryNote[]
  pendingTurns: PendingTurn[]
  pendingActivity: ActivityEntry[]
  needsConsolidation: boolean
  consolidation: Consolidation
  captureCounters: { always: number; likely: number; noiseSkipped: number }
  /** Notes inherited from the parent snapshot. Absent in files written before child inheritance; normalized on read. */
  notesInherited?: MemoryNote[]
  /** How many generations the inherited notes descend. 0 when the file has no parent. Normalized on read. */
  inheritedDepth?: number
  updatedAt: string
}

/** A file found in the memory directory. `corrupt` files are backups of a file that failed to parse. */
export interface MemoryFileEntry {
  readonly id: string
  readonly kind: "memory" | "corrupt"
  readonly file: string
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Validates a session id and keeps its brand, so it still fits the OpenCode session types. */
export function sanitizeSessionID<T extends string>(sessionID: T): T {
  if (!SESSION_ID_RE.test(sessionID)) throw new Error(`Invalid sessionID: ${sessionID}`)
  return sessionID
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
    summaryFactsInherited: "",
    summaryNarrative: "",
    notes: [],
    pendingTurns: [],
    pendingActivity: [],
    needsConsolidation: false,
    consolidation: emptyConsolidation(),
    captureCounters: { always: 0, likely: 0, noiseSkipped: 0 },
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

/**
 * Validates one stored note; a non-conforming element is dropped (null). The
 * parser contract only pins `text` and `tags` — the identity fields get
 * sensible defaults the same way activity entries do.
 */
function normalizeNote(raw: unknown): MemoryNote | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.text !== "string") return null
  if (!Array.isArray(r.tags) || !r.tags.every((t) => typeof t === "string")) return null
  return {
    id: typeof r.id === "string" ? r.id : randomUUID(),
    text: r.text,
    tags: r.tags as string[],
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
    source: r.source === "manual" ? "manual" : "auto",
  }
}

/**
 * Validates one stored turn; a non-conforming element is dropped (null). The
 * parser contract pins `turnId`/`messageID` as strings; the tier falls back
 * through `withTier` to the default "likely".
 */
function normalizeTurn(raw: unknown): PendingTurn | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.turnId !== "string" || typeof r.messageID !== "string") return null
  return withTier({
    turnId: r.turnId,
    messageID: r.messageID,
    userExcerpt: typeof r.userExcerpt === "string" ? r.userExcerpt : "",
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
    tier: r.tier as CaptureTier | undefined,
  })
}

/**
 * Repairs a parsed v4 file into a MemoryFile. The parser contract: a field of
 * the wrong type becomes the default and the repair is logged once per field
 * (dropped elements are counted); a field that is merely absent gets the same
 * default silently, like the files written before that field existed. Fields
 * not in the schema are dropped, so a file cannot smuggle state past the
 * parser. Unknown keys aside, this makes readMemory total: no input shape
 * throws, and every repair is visible in the log.
 */
function normalizeMemory(parsed: unknown, id: string): MemoryFile {
  const r = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  const fixed = new Map<string, number | undefined>()
  const mark = (field: string, dropped?: number) => fixed.set(field, dropped)
  const str = (field: string, value: unknown): string => {
    if (typeof value === "string") return value
    if (value !== undefined) mark(field)
    return ""
  }
  const strOrNull = (field: string, value: unknown): string | null => {
    if (typeof value === "string" || value === null) return value as string | null
    if (value !== undefined) mark(field)
    return null
  }
  const counters = (value: unknown): { always: number; likely: number; noiseSkipped: number } => {
    if (value === undefined || value === null) return { always: 0, likely: 0, noiseSkipped: 0 }
    const src = typeof value === "object" ? (value as Record<string, unknown>) : null
    const out = { always: 0, likely: 0, noiseSkipped: 0 }
    if (!src) {
      mark("captureCounters")
      return out
    }
    for (const key of ["always", "likely", "noiseSkipped"] as const) {
      const v = src[key]
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v
      else mark("captureCounters")
    }
    return out
  }
  const array = <T>(field: string, value: unknown, element: (raw: unknown) => T | null): T[] => {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      mark(field)
      return []
    }
    let dropped = 0
    const out: T[] = []
    for (const raw of value) {
      const el = element(raw)
      if (el === null) dropped += 1
      else out.push(el)
    }
    if (dropped > 0) mark(field, dropped)
    return out
  }
  const memory: MemoryFile = {
    version: SCHEMA_VERSION,
    sessionID: id,
    parentSnapshotFrom: strOrNull("parentSnapshotFrom", r.parentSnapshotFrom),
    build: str("build", r.build),
    summary: str("summary", r.summary),
    summaryFacts: str("summaryFacts", r.summaryFacts),
    summaryFactsInherited: str("summaryFactsInherited", r.summaryFactsInherited),
    summaryNarrative: str("summaryNarrative", r.summaryNarrative),
    notes: array("notes", r.notes, normalizeNote),
    notesInherited: array("notesInherited", r.notesInherited, normalizeNote),
    pendingTurns: array("pendingTurns", r.pendingTurns, normalizeTurn),
    pendingActivity: array("pendingActivity", r.pendingActivity, normalizeActivityEntry),
    needsConsolidation: r.needsConsolidation === true,
    consolidation: normalizeConsolidation(r.consolidation),
    captureCounters: counters(r.captureCounters),
    updatedAt: str("updatedAt", r.updatedAt),
  }
  // inheritedDepth: a valid number passes through; a merely absent one is
  // filled by the post-branch default below (parent → 1, else 0); a
  // present-but-wrong one is logged here and filled the same way.
  if (typeof r.inheritedDepth === "number" && Number.isFinite(r.inheritedDepth)) {
    memory.inheritedDepth = r.inheritedDepth
  } else if (r.inheritedDepth !== undefined) {
    mark("inheritedDepth")
  }
  for (const [field, dropped] of fixed) {
    logEvent("normalize", { sid: id, field, ...(dropped !== undefined ? { dropped } : {}) })
  }
  return memory
}

export async function readMemory(sessionID: string): Promise<MemoryFile> {
  const id = sanitizeSessionID(sessionID)
  const path = memoryPath(id)
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as MemoryFile | MemoryFileV1 | MemoryFileV2 | MemoryFileV3
    if (parsed.sessionID !== id) throw new Error("bad schema")
    let memory: MemoryFile
    if (parsed.version === 1) {
      memory = migrateV1(parsed as MemoryFileV1)
    } else if (parsed.version === 2) {
      memory = migrateV2(parsed as MemoryFileV2)
    } else if (parsed.version === 3) {
      const v3 = parsed as unknown as MemoryFileV3
      memory = {
        ...v3,
        version: SCHEMA_VERSION,
        build: parsed.build ?? BUILD,
        summary: parsed.summary ?? "",
        summaryFacts: parsed.summaryFacts ?? "",
        summaryFactsInherited: "",
        summaryNarrative: parsed.summaryNarrative ?? "",
        captureCounters: { always: 0, likely: 0, noiseSkipped: 0 },
        notes: parsed.notes ?? [],
        pendingTurns: (parsed.pendingTurns ?? []).map(withTier),
        pendingActivity: (parsed.pendingActivity ?? []).map(normalizeActivityEntry),
        needsConsolidation: parsed.needsConsolidation === true,
        consolidation: normalizeConsolidation(parsed.consolidation),
      }
    } else if (parsed.version === SCHEMA_VERSION) {
      memory = normalizeMemory(parsed, id)
    } else {
      throw new Error("bad schema")
    }
    // Additive v4 fields: files written before child inheritance carry no value,
    // so fill the defaults on every file that comes back as the current version
    // or through the v3 migration (which does not set them either).
    memory.notesInherited ??= []
    memory.inheritedDepth ??= memory.parentSnapshotFrom ? 1 : 0
    recoverStaleAttempt(memory)
    return memory
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyMemory(id)
    logEvent("quarantine", { sid: id })
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
  if (isDeleted(id)) {
    logEvent("write-skipped-deleted", { sid: id })
    return
  }
  const path = memoryPath(id)
  memory.sessionID = id
  memory.updatedAt = new Date().toISOString()
  // The build that last wrote the file is always the running build: a migration
  // is read-only and never stamps, so drift clears after the next real write.
  memory.build = BUILD
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
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

/**
 * Reads a session's memory while holding that session's lock, so a reader
 * never overtakes a concurrent `updateMemory` (I5): the in-flight update
 * finishes and its write lands before this read returns.
 */
export function readMemoryLocked(sessionID: string): Promise<MemoryFile> {
  return withLock(sessionID, () => readMemory(sessionID))
}

/** Suffix `(N)` that folds a repeated activity target, as the fact builders render it. */
const FACT_COUNTER_RE = / \(\d+x\)$/

/**
 * Dedupes fact lines by kind+target, first occurrence wins, so the head of the
 * chain stays the newest curated line. The `(Nx)` counter suffix takes no part
 * in the key: `- command: bun test (3x)` and `- command: bun test (17x)` are
 * the same fact and collapse onto the first shape. Blank lines are dropped;
 * lines that are not fact lines are keyed and kept verbatim.
 */
export function dedupeFactLines(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const parsed = line.match(/^- (file|command|error): (.+)$/)
    const key = parsed ? `${parsed[1]}\u0000${parsed[2]!.replace(FACT_COUNTER_RE, "")}` : line
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

/**
 * Builds the labeled child snapshot of a parent memory. Pure: no file IO, no
 * `collectDelta` (it mutates `attemptId`), and no mutation of `parent`.
 *
 * Facts: the parent's pending activity is curated to fact lines directly and
 * heads the inherited chain, ahead of the parent's own facts and the facts the
 * parent inherited — so the newest curated decision is always at the head.
 *
 * Final decision: the parent's turn excerpts are NOT inherited — the child
 * starts with its own conversation; only facts, notes and lineage carry over.
 */
export function buildSnapshot(parent: MemoryFile, toSessionID: string): MemoryFile {
  const curated = parent.pendingActivity.map(
    (a) => `- ${a.kind}: ${a.target}${a.count > 1 ? ` (${a.count}x)` : ""}`,
  )
  const inherited = dedupeFactLines([
    ...curated,
    ...(parent.summaryFacts ?? "").split("\n"),
    ...(parent.summaryFactsInherited ?? "").split("\n"),
  ]).join("\n")
  return {
    version: SCHEMA_VERSION,
    sessionID: toSessionID,
    // The snapshot is labeled with the session it came from (== the `from`
    // argument of copyMemory; readMemory guarantees they match).
    parentSnapshotFrom: parent.sessionID,
    build: BUILD,
    // Ringkasan & narasi parent BUKAN milik anak.
    summary: "",
    summaryFacts: "",
    summaryFactsInherited: inherited,
    summaryNarrative: "",
    // Note parent menjadi WARISAN anak, bukan claim pekerjaan anak.
    notes: [],
    notesInherited: [...(parent.notesInherited ?? []), ...parent.notes].slice(-20),
    // Kutipan turn parent tidak diwarisi: anak mulai dengan percakapannya sendiri.
    pendingTurns: [],
    pendingActivity: [],
    needsConsolidation: false,
    consolidation: emptyConsolidation(),
    // Counter capture milik sesi anak, bukan milik parent.
    captureCounters: { always: 0, likely: 0, noiseSkipped: 0 },
    inheritedDepth: (parent.inheritedDepth ?? (parent.parentSnapshotFrom ? 1 : 0)) + 1,
    updatedAt: new Date().toISOString(),
  }
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

/**
 * The files that may hold memory, log or build records. They are all private
 * to the user, so the repair tightens them to 0600.
 */
function isPrivateFile(name: string): boolean {
  if (name.endsWith(".json")) return true
  if (name.endsWith(".log")) return true
  // A corrupt backup of a memory file: `<session>.json.corrupt.<timestamp>`.
  return name.includes(".json.corrupt.")
}

/** Lists the memory files on disk, including the corrupt backups that a failed parse left behind. */

/** A tmp file older than this is a leftover from a crashed atomic write, not an in-flight one. */
const TMP_MAX_AGE_MS = 3600_000

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
      } else if (entry.isFile() && isPrivateFile(entry.name)) {
        try {
          await chmod(full, 0o600)
          files += 1
        } catch {}
      } else if (entry.isFile() && entry.name.includes(".tmp.")) {
        // A leftover from a crashed atomic write: remove it once it is old
        // enough not to be an in-flight write. It is not a private file, so
        // the counts stay unchanged.
        try {
          const stats = await stat(full)
          if (Date.now() - stats.mtimeMs > TMP_MAX_AGE_MS) await rm(full, { force: true })
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
    logEvent("tombstone-evict", { sid: oldest.value })
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

export interface MemoryFileV3 {
  version: 3
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
    summaryFactsInherited: "",
    summaryNarrative: "",
    notes: v2.notes ?? [],
    pendingTurns: (v2.pendingTurns ?? []).map(withTier),
    pendingActivity: (v2.pendingActivity ?? []).map(normalizeActivityEntry),
    needsConsolidation: v2.needsConsolidation === true,
    consolidation,
    captureCounters: { always: 0, likely: 0, noiseSkipped: 0 },
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
