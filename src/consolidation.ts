import { randomUUID } from "node:crypto"
import type { MemoryFile } from "./storage.js"

export interface Consolidation {
  state: "idle" | "running" | "failed"
  attemptId: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  consecutiveFailures: number
  deferrals: number
  deferredSince: string | null
  lastAttemptAt: string | null
  consolidatedNotes: number
}

export function emptyConsolidation(): Consolidation {
  return {
    state: "idle",
    attemptId: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    consecutiveFailures: 0,
    deferrals: 0,
    deferredSince: null,
    lastAttemptAt: null,
    consolidatedNotes: 0,
  }
}

const BACKOFF_STEPS = [60_000, 120_000, 240_000, 480_000, 600_000]

export function backoffMs(failureCount: number): number {
  if (!Number.isFinite(failureCount)) return 0
  const n = Math.trunc(failureCount)
  if (n <= 0) return 0
  return BACKOFF_STEPS[Math.min(n, BACKOFF_STEPS.length) - 1]!
}

export const RUNNING_TIMEOUT_MS = 5 * 60_000

export function recoverStaleAttempt(m: MemoryFile, now: number = Date.now()): boolean {
  const c = m.consolidation
  if (c.state !== "running") return false
  const started = c.startedAt ? Date.parse(c.startedAt) : NaN
  if (!Number.isNaN(started) && now - started < RUNNING_TIMEOUT_MS) return false
  c.state = "failed"
  c.finishedAt = new Date(now).toISOString()
  c.error = "stale attempt (timeout)"
  if (!Number.isFinite(c.consecutiveFailures)) c.consecutiveFailures = 0
  c.consecutiveFailures += 1
  c.attemptId = null
  return true
}

export function beginAttempt(m: MemoryFile, attemptId: string, now: number = Date.now()): void {
  const c = m.consolidation
  const iso = new Date(now).toISOString()
  c.state = "running"
  c.attemptId = attemptId
  c.startedAt = iso
  c.finishedAt = null
  c.error = null
  c.lastAttemptAt = iso
}

export function finishSuccess(m: MemoryFile, attemptId: string, now: number = Date.now()): boolean {
  const c = m.consolidation
  if (c.attemptId !== attemptId) return false
  c.state = "idle"
  c.attemptId = null
  c.finishedAt = new Date(now).toISOString()
  c.error = null
  c.consecutiveFailures = 0
  c.consolidatedNotes = m.notes.length
  return true
}

export function finishFailure(m: MemoryFile, attemptId: string, error: string, now: number = Date.now()): boolean {
  const c = m.consolidation
  if (c.attemptId !== attemptId) return false
  c.state = "failed"
  c.attemptId = null
  c.finishedAt = new Date(now).toISOString()
  c.error = String(error).slice(0, 200)
  if (!Number.isFinite(c.consecutiveFailures)) c.consecutiveFailures = 0
  c.consecutiveFailures += 1
  return true
}

export function retryDelayMs(m: MemoryFile, now: number = Date.now()): number {
  const c = m.consolidation
  if (!c.lastAttemptAt) return 0
  const elapsed = now - Date.parse(c.lastAttemptAt)
  if (!Number.isFinite(elapsed)) return 0
  const failed = c.state === "failed" || c.error !== null
  const required = failed ? backoffMs(c.consecutiveFailures) : 300_000
  const result = Math.max(0, required - elapsed)
  return Number.isFinite(result) ? result : 0
}

export function canConsolidate(m: MemoryFile, now: number = Date.now()): boolean {
  if (m.needsConsolidation !== true) return false
  if (m.consolidation?.state === "running") return false
  return retryDelayMs(m, now) === 0
}

export function shouldConsolidate(m: MemoryFile, now: number = Date.now()): boolean {
  return m.needsConsolidation && m.consolidation.state !== "running"
}

export const DEFERRAL_FALLBACK_COUNT = 3
export const DEFERRAL_FALLBACK_MS = 15 * 60_000

export function shouldDefer(m: MemoryFile, backgroundCount: number, now: number = Date.now()): boolean {
  const c = m.consolidation
  if (!(backgroundCount > 0)) return false
  const deferrals = Number.isFinite(c.deferrals) ? c.deferrals : 0
  if (!(deferrals < DEFERRAL_FALLBACK_COUNT)) return false
  if (c.deferredSince === null) return true
  const since = Date.parse(c.deferredSince)
  if (!Number.isFinite(since)) return true
  return now - since < DEFERRAL_FALLBACK_MS
}

export function noteDeferral(m: MemoryFile, now: number = Date.now()): void {
  const c = m.consolidation
  if (!Number.isFinite(c.deferrals)) c.deferrals = 0
  c.deferrals += 1
  if (c.deferredSince === null) c.deferredSince = new Date(now).toISOString()
}

export function deltaAttemptId(): string {
  return randomUUID()
}