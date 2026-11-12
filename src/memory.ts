import { randomUUID } from "node:crypto"
import type { MemoryFile, MemoryNote, PendingTurn } from "./storage.js"
import { capActivity, capPendingTurns, readMemory, writeMemory } from "./storage.js"
import { defaultTokenCounter, truncateToTokenBudget } from "./tokenizer.js"
import { redact } from "./redact.js"
import { deltaAttemptId } from "./consolidation.js"

export interface Delta {
  readonly attemptId: string
  readonly turnIds: string[]
  readonly activityIds: string[]
  /** Turn excerpts, so the prompt can carry the quotes and not just their ids. */
  readonly turns: readonly { readonly turnId: string; readonly excerpt: string }[]
  readonly notes: readonly MemoryNote[]
  readonly summary: string
  readonly facts: string
}

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

function isDelta(input: MemoryFile | Delta): input is Delta {
  return "attemptId" in input
}

export function buildConsolidationInput(input: MemoryFile | Delta, budget = 12000): string {
  if (isDelta(input)) return buildConsolidationPrompt(input, budget)
  const memory = input as MemoryFile
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

export function collectDelta(m: MemoryFile): Delta {
  if (m.consolidation.attemptId == null) {
    m.consolidation.attemptId = deltaAttemptId()
  }
  const attemptId = m.consolidation.attemptId as string
  const turnIds = m.pendingTurns.map((t) => t.turnId)
  const turns = m.pendingTurns.map((t) => ({ turnId: t.turnId, excerpt: t.userExcerpt }))
  const activityIds = m.pendingActivity.map((a) => a.id)
  const notes = [...m.notes] as readonly MemoryNote[]
  const summary = m.summary
  const facts = m.pendingActivity
    .map((a) => `- ${a.kind}: ${a.target}${a.count > 1 ? ` (${a.count}x)` : ""}`)
    .join("\n")
  return { attemptId, turnIds, turns, activityIds, notes, summary, facts }
}

export function buildConsolidationPrompt(delta: Delta, budget: number): string {
  const parts: string[] = []
  if (delta.summary) parts.push(`CURRENT SUMMARY:\n${delta.summary}`)
  if (delta.facts) parts.push(`FACTS:\n${delta.facts}`)
  if (delta.turns.length) parts.push(`CONVERSATION:\n${delta.turns.map((t) => `- ${t.excerpt}`).join("\n")}`)
  if (delta.notes.length) parts.push(`MANUAL NOTES:\n${delta.notes.map((n) => `- ${n.text}`).join("\n")}`)
  parts.push(`Tulis ringkasan final di bawah ${budget} token. Jangan sertakan output mentah.`)
  return parts.join("\n\n")
}

export type ConsolidationMode = "stateless" | "session"

/**
 * Consolidation never needs the session's message history, so the stateless
 * generator is the default. The session-scoped path stays available as an
 * explicit option.
 */
export function defaultConsolidationMode(): ConsolidationMode {
  return "stateless"
}

/** Estimated prompt size, logged for every consolidation so cost is visible. */
export function estimatePromptTokens(prompt: string): number {
  return defaultTokenCounter(prompt)
}

/**
 * Runs an operation once more before giving up. The stateless generator has no
 * backoff of its own, so the second call is identical; the consolidation state
 * machine still records the failure when both attempts fail.
 */
export async function retryOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch {
    return await run()
  }
}

export type ConsolidationDeps = {
  collect: () => Promise<Delta | null>
  generate: (delta: Delta) => Promise<string>
  apply: (delta: Delta, narrative: string) => Promise<void>
  fail?: (delta: Delta, error: string) => Promise<void>
}

/**
 * Three-phase consolidation: collect takes the lock and releases it, generate runs
 * with no lock held, then apply takes the lock again. Keeping this orchestration
 * injectable is what makes the lock discipline testable.
 */
export async function runConsolidation(deps: ConsolidationDeps): Promise<"skipped" | "applied" | "failed"> {
  const delta = await deps.collect()
  if (!delta) return "skipped"
  let narrative: string
  try {
    narrative = await deps.generate(delta)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (deps.fail) await deps.fail(delta, error)
    return "failed"
  }
  await deps.apply(delta, narrative)
  return "applied"
}

/** Merges fact lines across cycles, dropping exact duplicates and keeping order. */
function mergeFacts(oldFacts: string, newFacts: string): string {
  const lines = [...oldFacts.split("\n"), ...newFacts.split("\n")]
    .map((line) => line.trim())
    .filter(Boolean)
  return [...new Set(lines)].join("\n")
}

export function applyDelta(m: MemoryFile, delta: Delta, narrative: string): void {
  if (m.consolidation.attemptId !== delta.attemptId) return
  const turnSet = new Set(delta.turnIds)
  const activitySet = new Set(delta.activityIds)
  m.pendingTurns = m.pendingTurns.filter((t) => !turnSet.has(t.turnId))
  m.pendingActivity = m.pendingActivity.filter((a) => !activitySet.has(a.id))
  const text = narrative.trim()
  m.summaryFacts = mergeFacts(m.summaryFacts, delta.facts)
  m.summaryNarrative = text
  m.summary = [m.summaryFacts, text].filter(Boolean).join("\n\n")
  m.consolidation.consolidatedNotes = m.notes.length
  if (m.pendingTurns.length === 0 && m.pendingActivity.length === 0) {
    m.needsConsolidation = false
  }
}
