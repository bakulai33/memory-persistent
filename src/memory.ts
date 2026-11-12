import { randomUUID } from "node:crypto"
import type { MemoryFile, MemoryNote, PendingTurn } from "./storage.js"
import { capActivity, capPendingTurns, readMemory, writeMemory } from "./storage.js"
import { defaultTokenCounter, truncateToTokenBudget } from "./tokenizer.js"
import { redact } from "./redact.js"

export function addPendingTurn(memory: MemoryFile, turn: PendingTurn): void {
  memory.pendingTurns = capPendingTurns([...memory.pendingTurns, turn], 20)
  memory.needsConsolidation = true
}

export function appendNote(memory: MemoryFile, text: string, tags: string[] = [], source: "manual" | "auto" = "manual"): MemoryNote {
  const note: MemoryNote = {
    id: randomUUID(),
    text: redact(text),
    tags,
    createdAt: new Date().toISOString(),
    source,
  }
  memory.notes.push(note)
  memory.needsConsolidation = true
  return note
}

export function removeNote(memory: MemoryFile, id: string): boolean {
  const before = memory.notes.length
  memory.notes = memory.notes.filter((n) => n.id !== id)
  return memory.notes.length < before
}

type Section = { text: string; capPct: number }

/**
 * Splits a token budget across sections by priority.
 *
 * Every section keeps its share of the budget, and a section that is smaller
 * than its share hands the remainder to the sections that were cut, so a short
 * summary never starves the conversation.
 */
export function allocate(sections: (Section | undefined)[], budget: number): number[] {
  const sizes = sections.map((section) => (section ? defaultTokenCounter(section.text) : 0))
  const allowance = sections.map((section, index) =>
    section ? Math.min(sizes[index]!, Math.floor(budget * section.capPct)) : 0,
  )
  const total = allowance.reduce((a, b) => a + b, 0)
  if (total > budget) {
    const scale = budget / total
    for (let index = 0; index < allowance.length; index++) allowance[index] = Math.floor(allowance[index]! * scale)
    return allowance
  }
  let leftover = budget - total
  for (let index = 0; index < allowance.length && leftover > 0; index++) {
    const room = sizes[index]! - allowance[index]!
    if (room <= 0) continue
    const give = Math.min(room, leftover)
    allowance[index] = allowance[index]! + give
    leftover -= give
  }
  return allowance
}

export function buildInjection(memory: MemoryFile, budget = 5000): string {
  const summary = memory.summary ? `Summary:\n${memory.summary}` : ""
  const conversation = memory.pendingTurns.length
    ? `Conversation:\n${memory.pendingTurns.map((t) => `- ${t.userExcerpt}`).join("\n")}`
    : ""
  const notes = memory.notes.length
    ? `Manual notes:\n${memory.notes.map((n) => `- ${n.text}`).join("\n")}`
    : ""
  const activity = memory.pendingActivity.length
    ? `Activity:\n${memory.pendingActivity.map((a) => `- ${a.kind}: ${a.target}${a.count > 1 ? ` (${a.count}x)` : ""}`).join("\n")}`
    : ""

  const sections: (Section | undefined)[] = [
    summary ? { text: summary, capPct: 0.45 } : undefined,
    conversation ? { text: conversation, capPct: 0.3 } : undefined,
    notes ? { text: notes, capPct: 0.15 } : undefined,
    activity ? { text: activity, capPct: 0.1 } : undefined,
  ]
  const allowance = allocate(sections, budget)
  const parts: string[] = []
  sections.forEach((section, index) => {
    if (!section) return
    const piece = truncateToTokenBudget(section.text, allowance[index]!)
    if (piece) parts.push(piece)
  })
  return parts.join("\n\n")
}

/** Cuts at a line boundary so a decision is never cut in half. */
function cutLines(text: string, maxTokens: number): string {
  if (defaultTokenCounter(text) <= maxTokens) return text
  const lines = text.split("\n")
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = defaultTokenCounter(line) + 1
    if (used + cost > maxTokens) break
    kept.push(line)
    used += cost
  }
  if (kept.length === 0) return truncateToTokenBudget(text, maxTokens)
  return kept.join("\n")
}

export function buildConsolidationInput(memory: MemoryFile, budget = 12000): string {
  // Headers label the sections for the model; they are not part of the
  // content budget, so a tiny allowance still carries at least one line.
  const summary = memory.summary ? { header: "CURRENT SUMMARY:", body: memory.summary } : undefined
  const conversation = memory.pendingTurns.length
    ? { header: "CONVERSATION:", body: memory.pendingTurns.map((t) => `- ${t.userExcerpt}`).join("\n") }
    : undefined
  const notes = memory.notes.length
    ? { header: "MANUAL NOTES:", body: memory.notes.map((n) => `- ${n.text}`).join("\n") }
    : undefined
  const activity = memory.pendingActivity.length
    ? {
        header: "ACTIVITY:",
        body: memory.pendingActivity.map((a) => `- ${a.kind}: ${a.target}${a.count > 1 ? ` (${a.count}x)` : ""}`).join("\n"),
      }
    : undefined

  const sections: (Section | undefined)[] = [
    summary ? { text: summary.body, capPct: 0.4 } : undefined,
    conversation ? { text: conversation.body, capPct: 0.35 } : undefined,
    notes ? { text: notes.body, capPct: 0.15 } : undefined,
    activity ? { text: activity.body, capPct: 0.1 } : undefined,
  ]
  const allowance = allocate(sections, budget)
  const parts: string[] = []
  const labeled = [summary, conversation, notes, activity]
  sections.forEach((section, index) => {
    if (!section) return
    const piece = cutLines(section.text, allowance[index]!)
    if (piece) parts.push(`${labeled[index]!.header}\n${piece}`)
  })
  return parts.join("\n\n")
}

const BACKOFF_STEPS = [60_000, 120_000, 240_000, 480_000, 600_000]

/** How long to wait after the given number of consecutive failures. */
export function backoffMs(failureCount: number): number {
  if (failureCount <= 0) return 0
  return BACKOFF_STEPS[Math.min(failureCount, BACKOFF_STEPS.length) - 1]!
}

/** How long the session must wait before the next consolidation attempt. */
export function retryDelayMs(memory: MemoryFile, now = Date.now()): number {
  if (!memory.lastAttemptAt) return 0
  const elapsed = now - Date.parse(memory.lastAttemptAt)
  if (Number.isNaN(elapsed)) return 0
  const required = memory.lastFailure ? backoffMs(memory.failureCount) : 300_000
  return Math.max(0, required - elapsed)
}

export function canConsolidate(memory: MemoryFile, now = Date.now()): boolean {
  if (!memory.needsConsolidation) return false
  if (!memory.lastAttemptAt) return true
  return retryDelayMs(memory, now) === 0
}

export async function loadMemory(sessionID: string, parentSnapshotFrom: string | null = null): Promise<MemoryFile> {
  return readMemory(sessionID).then((m) => {
    if (m.sessionID !== sessionID) m.sessionID = sessionID
    if (parentSnapshotFrom && !m.parentSnapshotFrom) m.parentSnapshotFrom = parentSnapshotFrom
    return m
  })
}

export async function saveMemory(sessionID: string, memory: MemoryFile): Promise<void> {
  await writeMemory(sessionID, memory)
}

export function markAttempt(memory: MemoryFile): void {
  memory.lastAttemptAt = new Date().toISOString()
  memory.failureCount += 1
}

export function markSuccess(memory: MemoryFile): void {
  memory.lastSuccessAt = new Date().toISOString()
  memory.lastFailure = null
  memory.failureCount = 0
}

export function markFailure(memory: MemoryFile, reason: string): void {
  memory.lastFailure = reason.slice(0, 200)
}
