import { BUILD } from "./build.js"
import type { CaptureTier } from "./capture.js"
import { retryDelayMs } from "./consolidation.js"
import { redact } from "./redact.js"
import type { MemoryFile } from "./storage.js"
import { logPath as storageLogPath } from "./storage.js"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** A logged value is cut short at this length. */
const ERROR_LIMIT = 300

/**
 * Observability for the plugin: the health report the model can ask for, and
 * the structured log lines that make a silent failure visible.
 *
 * The report is a pure function of its inputs, so it can be unit-tested
 * without a running plugin.
 */

/** How many prompts each capture tier has seen in one session. */
export interface CaptureCounters {
  always: number
  likely: number
  noiseSkipped: number
}

/** What the last consolidation attempt of a session cost. */
export interface LastConsolidation {
  estPromptTokens: number
  ms: number
  at: string
}

/** The state of the plugin for one session, as the `memory_health` tool reports it. */
export interface HealthReport {
  /** The build of the running plugin. */
  build: string
  /** The build that last wrote the memory file. */
  fileBuild: string
  /** True when the memory file was written by another build. */
  drift: boolean
  /** True when the running source tree can link. */
  sourceTreeOk: boolean
  /** The hash of the running source tree. */
  sourceHash: string
  consolidation: {
    state: string
    error: string | null
    consecutiveFailures: number
    nextRetryInMs: number | null
  }
  pending: { turns: number; activity: number; notes: number }
  lastConsolidation: LastConsolidation | null
  capture: CaptureCounters
  /** Where the plugin's structured log lines are written. */
  logPath: string
}

/** The parts of the report that do not come from the memory file. */
export interface HealthOptions {
  /** The moment the report is computed. Defaults to now. */
  now?: number
  /** Whether the running source tree can link. Defaults to true. */
  sourceTreeOk?: boolean
  
  /** The last consolidation. Defaults to the one recorded for the session. */
  lastConsolidation?: LastConsolidation | null
  /** Where the plugin log lives. Defaults to the plugin's own log path. */
  logPath?: string
}

/** Where the plugin writes its structured log lines. Re-exported from storage. */
export function logPath(): string {
  return storageLogPath()
}

/** The build state of the running plugin. */
export interface HealthRuntime {
  build: string
  sourceHash: string
  sourceTreeOk: boolean
}

// The sessions are bounded so a long-running server does not keep one entry
// per session it ever saw.
const SESSION_LIMIT = 256

interface SessionState {
  capture: CaptureCounters
  lastConsolidation: LastConsolidation | null
}

const sessions = new Map<string, SessionState>()

// The drift is logged once per build pair, so a drifted session does not
// repeat the line on every turn.
const driftLogged = new Map<string, string>()

let runtime: HealthRuntime = { build: BUILD, sourceHash: "", sourceTreeOk: true }

function emptyCounters(): CaptureCounters {
  return { always: 0, likely: 0, noiseSkipped: 0 }
}

function stateFor(sessionID: string): SessionState {
  let state = sessions.get(sessionID)
  if (!state) {
    state = { capture: emptyCounters(), lastConsolidation: null }
    sessions.set(sessionID, state)
    while (sessions.size > SESSION_LIMIT) {
      const oldest = sessions.keys().next()
      if (oldest.done) break
      sessions.delete(oldest.value)
    }
  }
  return state
}

/** Records the build of the running plugin, so a report can name it. */
export function setHealthRuntime(next: HealthRuntime): void {
  runtime = { ...next }
}

/** The build state of the running plugin. */
export function healthRuntime(): HealthRuntime {
  return { ...runtime }
}

/** Menaikkan counter capture pada objek memory (tanpa I/O). */
export function bumpCaptureCounter(counters: CaptureCounters, tier: CaptureTier): void {
  if (tier === "always") counters.always += 1
  else if (tier === "likely") counters.likely += 1
  else counters.noiseSkipped += 1
}

/** Records what the last consolidation attempt of a session cost. */
export function recordConsolidation(
  sessionID: string,
  info: { estPromptTokens: number; ms: number; at?: string },
): void {
  stateFor(sessionID).lastConsolidation = {
    estPromptTokens: Math.max(0, Math.trunc(info.estPromptTokens)),
    ms: Math.max(0, Math.trunc(info.ms)),
    at: info.at ?? new Date().toISOString(),
  }
}

/** The capture counters of one session, read from the memory file. */
export function captureCountersOf(m: MemoryFile): CaptureCounters {
  return { ...m.captureCounters }
}

/** The last consolidation of one session, or null when none ran. */
export function lastConsolidation(sessionID: string): LastConsolidation | null {
  const state = sessions.get(sessionID)
  return state?.lastConsolidation ? { ...state.lastConsolidation } : null
}

/** Forgets the recorded state of one session, or of every session. */
export function resetHealthState(sessionID?: string): void {
  if (sessionID === undefined) {
    sessions.clear()
    driftLogged.clear()
    return
  }
  sessions.delete(sessionID)
  driftLogged.delete(sessionID)
}

/** The build that last wrote a memory file. */
export function fileBuildOf(m: MemoryFile): string {
  return typeof m.build === "string" ? m.build : ""
}

/** Redacts and caps a consolidation error the same way `logEvent` does. */
function redactError(error: string | null): string | null {
  if (error === null) return null
  let text = redact(error)
  if (text.length > ERROR_LIMIT) text = `${text.slice(0, ERROR_LIMIT)}…`
  return text
}

/**
 * Builds the health report of one session.
 *
 * The report only ever describes the session it is given: the counters come
 * from that session's own record, so no other session can leak into it.
 */
export function buildHealthReport(
  m: MemoryFile,
  running: { build: string; sourceHash: string },
  options: HealthOptions = {},
): HealthReport {
  const now = options.now ?? Date.now()
  const fileBuild = fileBuildOf(m)
  const last = options.lastConsolidation === undefined ? null : options.lastConsolidation
  // A retry is pending only while the backoff has not elapsed yet.
  const delay = m.needsConsolidation ? retryDelayMs(m, now) : 0

  return {
    build: running.build,
    fileBuild,
    drift: fileBuild !== running.build,
    sourceTreeOk: options.sourceTreeOk ?? true,
    sourceHash: running.sourceHash,
    consolidation: {
      state: m.consolidation.state,
      error: redactError(m.consolidation.error),
      consecutiveFailures: m.consolidation.consecutiveFailures,
      nextRetryInMs: delay > 0 ? delay : null,
    },
    pending: {
      turns: m.pendingTurns.length,
      activity: m.pendingActivity.length,
      notes: m.notes.length,
    },
    lastConsolidation: last ? { ...last } : null,
    capture: captureCountersOf(m),
    logPath: options.logPath ?? logPath(),
  }
}

/** Every log line of the plugin starts with this prefix. */
export const LOG_PREFIX = "[memory-persistent] "

// Cap for the plugin log file: keep the most recent lines so the file cannot
// grow without bound. 64 KiB is small enough to read at a glance and large
// enough to hold a useful tail of structured events.
const LOG_MAX_BYTES = 64 * 1024

/** A logged value never carries a secret, so every string is redacted first. */
function formatValue(key: string, value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0"
  if (typeof value === "boolean") return value ? "true" : "false"
  let text = redact(String(value))
  if (key === "error" && text.length > ERROR_LIMIT) text = `${text.slice(0, ERROR_LIMIT)}…`
  if (text === "") return '""'
  if (/[\s"]/.test(text)) return JSON.stringify(text)
  return text
}

/**
 * Writes one structured log line: the prefix, the event, then key=value pairs.
 * A value that carries a space is quoted, so the line stays parseable.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const parts = [event]
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue
    parts.push(`${key}=${formatValue(key, value)}`)
  }
  const line = `${LOG_PREFIX}${parts.join(" ")}`
  console.error(line)
  // Persist the same line to the plugin's own log file, since the server does
  // not capture plugin console output. Redaction already happened above.
  try {
    const path = logPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 })
    let size = 0
    let mode = 0
    try {
      const stat = statSync(path)
      size = stat.size
      mode = stat.mode & 0o777
    } catch {
      size = 0
    }
    // The mode of a write only applies to a file it creates, so a log that
    // already exists keeps its old permissions until they are corrected here.
    if (mode !== 0o600) {
      try {
        chmodSync(path, 0o600)
      } catch {
        // A log that cannot be tightened is still worth writing.
      }
    }
    if (size > LOG_MAX_BYTES) {
      const content = readFileSync(path, "utf8")
      const lines = content.split("\n")
      if (lines.length && lines[lines.length - 1] === "") lines.pop()
      const kept: string[] = []
      let keptBytes = 0
      for (let i = lines.length - 1; i >= 0; i--) {
        const lineBytes = Buffer.byteLength(lines[i], "utf8") + 1
        if (kept.length > 0 && keptBytes + lineBytes > LOG_MAX_BYTES) break
        kept.unshift(lines[i])
        keptBytes += lineBytes
      }
      writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 })
      try {
        chmodSync(path, 0o600)
      } catch {
        // The truncation already happened; a tighter mode is best effort.
      }
    }
  } catch {
    // Logging must never throw into the plugin.
  }
}

/**
 * Reports a build drift between a memory file and the running plugin. The same
 * pair is reported once; a session that already drifted is not repeated.
 */
export function logDrift(sessionID: string, fileBuild: string, runningBuild: string = runtime.build): void {
  if (fileBuild === runningBuild) return
  if (driftLogged.get(sessionID) === fileBuild) return
  driftLogged.set(sessionID, fileBuild)
  while (driftLogged.size > SESSION_LIMIT) {
    const oldest = driftLogged.keys().next()
    if (oldest.done) break
    driftLogged.delete(oldest.value)
  }
  logEvent("drift", { sid: sessionID, fileBuild, runningBuild })
}