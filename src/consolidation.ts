import { randomUUID } from "node:crypto"
import type { MemoryFile } from "./storage.js"
import { buildConsolidationInput, estimatePromptTokens } from "./memory.js"
import { redact } from "./redact.js"

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
  pendingSince: string | null
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
    pendingSince: null,
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

/**
 * Attempts whose consolidation fiber is alive in this process (P1-4). A slow
 * model call must not be discarded by another session's recovery sweep just
 * because `startedAt` passed the running timeout.
 */
const activeAttempts = new Map<string, number>()

/**
 * Registrations older than this are pruned, so a fiber that died without
 * finishing (crash) cannot protect its attempt forever.
 */
export const ACTIVE_ATTEMPT_TTL_MS = 30 * 60_000

function pruneActiveAttempts(now: number): void {
  for (const [id, started] of activeAttempts) {
    if (now - started > ACTIVE_ATTEMPT_TTL_MS) activeAttempts.delete(id)
  }
}

/** Diagnostic: when `attemptId` was registered (epoch ms), or null. */
export function activeAttemptAt(attemptId: string): number | null {
  return activeAttempts.get(attemptId) ?? null
}

export function recoverStaleAttempt(m: MemoryFile, now: number = Date.now()): boolean {
  pruneActiveAttempts(now)
  const c = m.consolidation
  if (c.state !== "running") return false
  const started = c.startedAt ? Date.parse(c.startedAt) : NaN
  if (!Number.isNaN(started) && now - started < RUNNING_TIMEOUT_MS) return false
  // The fiber may still be alive in this process: a registered attempt is
  // protected. Once the registration is pruned (crash), recovery proceeds.
  if (c.attemptId !== null) {
    if (activeAttempts.has(c.attemptId)) return false
    activeAttempts.delete(c.attemptId)
  }
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
  pruneActiveAttempts(now)
  activeAttempts.set(attemptId, now)
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
  activeAttempts.delete(attemptId)
  c.state = "idle"
  c.attemptId = null
  c.finishedAt = new Date(now).toISOString()
  c.error = null
  c.consecutiveFailures = 0
  c.consolidatedNotes = m.notes.length
  // Success refills the deferral budget: the next background burst defers
  // again from zero instead of falling back forever (P1-1).
  c.deferrals = 0
  c.deferredSince = null
  return true
}

export function finishFailure(m: MemoryFile, attemptId: string, error: string, now: number = Date.now()): boolean {
  const c = m.consolidation
  if (c.attemptId !== attemptId) return false
  activeAttempts.delete(attemptId)
  c.state = "failed"
  c.attemptId = null
  c.finishedAt = new Date(now).toISOString()
  c.error = redact(String(error)).slice(0, 200)
  if (!Number.isFinite(c.consecutiveFailures)) c.consecutiveFailures = 0
  c.consecutiveFailures += 1
  // A failed attempt must keep the pending work visible: the flag stays on so
  // the scheduler retries after backoff instead of dropping the turns.
  m.needsConsolidation = true
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

export function countNewNotes(m: MemoryFile): number {
  const consolidated = Number.isFinite(m.consolidation?.consolidatedNotes)
    ? m.consolidation.consolidatedNotes
    : 0
  const total = Number.isFinite(m.notes?.length) ? m.notes.length : 0
  const diff = total - consolidated
  return Number.isFinite(diff) ? diff : 0
}

export function shouldConsolidate(m: MemoryFile, now: number = Date.now()): boolean {
  if (m.needsConsolidation !== true) return false
  if (m.consolidation?.state === "running") return false
  if (m.pendingTurns.length >= 4) return true
  if (m.pendingActivity.length >= 8) return true
  if (countNewNotes(m) >= 1) {
    const prompt = buildConsolidationInput(m, 12000)
    if (estimatePromptTokens(prompt) >= 500) return true
  }
  const ref = m.consolidation?.lastAttemptAt ?? m.consolidation?.pendingSince
  if (typeof ref === "string") {
    const elapsed = now - Date.parse(ref)
    if (Number.isFinite(elapsed) && elapsed > 10 * 60_000) return true
  }
  return false
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