import { randomUUID } from "node:crypto"
import type { MemoryFile, MemoryNote, PendingTurn } from "./storage.js"
import { capActivity, capPendingTurns, readMemory, readMemoryLocked, writeMemory, buildSnapshot } from "./storage.js"
import { defaultTokenCounter, truncateToTokenBudget } from "./tokenizer.js"
import { redact } from "./redact.js"
import { deltaAttemptId } from "./consolidation.js"

/** Reserved share of the budget for the deterministic facts half. */
export const FACTS_BUDGET_SHARE = 0.35
/** Reserved share of the budget for the model narrative half. */
export const NARRATIVE_BUDGET_SHARE = 0.15
/** Reserved share of the budget for the combined summary. */
export const SUMMARY_BUDGET_SHARE = 0.5
/** Alias kept for callers that use the short name. */
export const SUMMARY_SHARE = SUMMARY_BUDGET_SHARE
/** Shared cap used by buildInjection and the write path. */
export const summaryCap = SUMMARY_BUDGET_SHARE
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
  if (memory.consolidation && memory.consolidation.pendingSince == null) {
    memory.consolidation.pendingSince = new Date().toISOString()
  }
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
  /** Token yang dianggarkan untuk tiap separator "\n\n" antar bagian. */
  const SEPARATOR_TOKENS = 1

  const parts = sections.filter(Boolean).length
  const separatorCost = SEPARATOR_TOKENS * Math.max(0, parts - 1)
  const usable = Math.max(0, budget - separatorCost)

  const sizes = sections.map((section) => (section ? defaultTokenCounter(section.text) : 0))
  const allowance = sections.map((section, index) =>
    section ? Math.min(sizes[index]!, Math.floor(usable * section.capPct)) : 0,
  )
  const total = allowance.reduce((a, b) => a + b, 0)
  if (total > usable) {
    const scale = usable / total
    for (let index = 0; index < allowance.length; index++) allowance[index] = Math.floor(allowance[index]! * scale)
    return allowance
  }
  let leftover = usable - total
  for (let index = 0; index < sections.length && leftover > 0; index++) {
    const room = sizes[index]! - allowance[index]!
    if (room <= 0) continue
    const give = Math.min(room, leftover)
    allowance[index] = allowance[index]! + give
    leftover -= give
  }
  return allowance
}

/** Header yang menandai narasi model sebagai belum terverifikasi. */
const NARRATIVE_LABEL = "Notes (model-generated, unverified):"

/** Depth 1/undefined = parent label (pinned string, keep exact); >1 = N earlier sessions. */
function depthLabel(depth?: number): string {
  return depth !== undefined && depth > 1 ? `Inherited from ${depth} earlier sessions:` : "Inherited from parent session:"
}

export function buildInjection(memory: MemoryFile, budget = 5000): string {
  let summaryCore = ""
  if (memory.summaryFacts || memory.summaryFactsInherited || memory.summaryNarrative) {
    const cap = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0
    const factsBudget = Math.floor(cap * FACTS_BUDGET_SHARE)
    const narrativeBudget = Math.floor(cap * NARRATIVE_BUDGET_SHARE)
    const summaryBudget = Math.floor(cap * SUMMARY_BUDGET_SHARE)
    const ownFacts = (memory.summaryFacts ?? "").trim()
    const inheritedFacts = (memory.summaryFactsInherited ?? "").trim()
    // Own facts are resolved against factsBudget FIRST (tail-keep = newest).
    // Inherited get only the REMAINING budget, truncated keep-head on the
    // labeled block (label survives at the head).
    const ownPart = truncateFacts(ownFacts, factsBudget)
    const remaining = Math.max(0, factsBudget - defaultTokenCounter(ownPart))
    const inheritedPart = inheritedFacts ? truncateToTokenBudget(`${depthLabel(memory.inheritedDepth)}\n${inheritedFacts}`, remaining) : ""
    const factsText = [ownPart, inheritedPart].filter(Boolean).join("\n\n")
    const narrativeRaw = (memory.summaryNarrative ?? "").trim()
    const narrativeFitted = fitNarrative(factsText, narrativeRaw, narrativeBudget, summaryBudget)
    const narrativePart = narrativeFitted
      ? `${NARRATIVE_LABEL}\n${narrativeFitted}`
      : ""
    summaryCore = [factsText, narrativePart].filter(Boolean).join("\n\n")
    if (defaultTokenCounter(summaryCore) > summaryBudget) summaryCore = truncateToTokenBudget(summaryCore, summaryBudget)
  } else if (memory.summary) {
    summaryCore = memory.summary
  }
  const summary = summaryCore ? `Summary:\n${summaryCore}` : ""
  const conversation = memory.pendingTurns.length
    ? `Conversation:\n${memory.pendingTurns.map((t) => `- ${t.userExcerpt}`).join("\n")}`
    : ""
  // Seksi notes TUNGGAL: own lines dulu, lalu blok inherited berlabel.
  // Truncation keep-head per seksi (cap 0.15) memotong inherited lebih dulu,
  // jadi own menang secara alami tanpa aritmetika budget baru.
  const ownNoteLines = memory.notes.map((n) => `- ${n.text}`)
  const inheritedNoteLines = (memory.notesInherited ?? []).map((n) => `- ${n.text}`)
  const notes = ownNoteLines.length || inheritedNoteLines.length
    ? ["Manual notes:", ...ownNoteLines, ...(inheritedNoteLines.length ? ["Manual notes (inherited):", ...inheritedNoteLines] : [])].join("\n")
    : ""
  const activity = memory.pendingActivity.length
    ? `Activity:\n${memory.pendingActivity.map((a) => `- ${a.kind}: ${a.target}${a.count > 1 ? ` (${a.count}x)` : ""}`).join("\n")}`
    : ""

  const sections: (Section | undefined)[] = [
    summary ? { text: summary, capPct: SUMMARY_BUDGET_SHARE } : undefined,
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

/**
 * Builds the payload returned by `memory_recall`, keeping the pure assembly logic
 * testable without the plugin loader. Facts are reported as stored: `summaryFacts`
 * holds this session's own facts, `summaryFactsInherited` the parent's facts.
 */
export function buildRecallPayload(
  memory: MemoryFile,
  budget = 5000,
  query?: string,
): {
  summary: string
  summaryFacts: string
  summaryFactsInherited: string
  summaryNarrative: string
  summaryNarrativeVerified: boolean
  notes: MemoryFile["notes"]
  notesInherited: MemoryFile["notes"]
  pendingTurns: string[]
  injection: string
} {
  const injection = buildInjection(memory, budget)
  // Predicate filter yang sama untuk own dan inherited agar recall konsisten.
  const matchesQuery = (n: { text: string; tags: string[] }, q: string) =>
    n.text.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q))
  let notes: MemoryFile["notes"] = memory.notes
  let notesInherited: MemoryFile["notes"] = memory.notesInherited ?? []
  if (query) {
    const q = String(query).toLowerCase()
    notes = notes.filter((n) => matchesQuery(n, q))
    notesInherited = notesInherited.filter((n) => matchesQuery(n, q))
  }
  return {
    summary: memory.summary,
    summaryFacts: memory.summaryFacts,
    summaryFactsInherited: memory.summaryFactsInherited,
    summaryNarrative: memory.summaryNarrative,
    summaryNarrativeVerified: false,
    notes,
    notesInherited,
    pendingTurns: memory.pendingTurns.map((t) => t.userExcerpt),
    injection,
  }
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

/**
 * Copies a parent's memory into a labeled child snapshot. The parent is read
 * under its lock (`readMemoryLocked`), so an in-flight update finishes first,
 * and the child is built by the pure `buildSnapshot`.
 */
export async function copyMemory(fromSessionID: string, toSessionID: string): Promise<void> {
  if (fromSessionID === toSessionID) return
  const parent = await readMemoryLocked(fromSessionID)
  await writeMemory(toSessionID, buildSnapshot(parent, toSessionID))
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

/** Buang suffix counter agar varian menyatu. */
function stripCounter(target: string): string {
  return target.replace(/ \(\d+x\)$/, "")
}

/** Target activity harus satu baris & tidak memuat blok argumen bocor. */
function isSaneTarget(kind: string, target: string): boolean {
  if (!target.trim()) return false
  if (target.includes("\n")) return false
  if (kind === "file" && target.length > 400) return false
  return true
}

function parseFactLine(line: string): { kind: string; target: string; count: number } | null {
  const m = line.match(/^- (file|command|error): (.+?)(?: \((\d+)x\))?$/)
  if (!m) return null
  return { kind: m[1]!, target: m[2]!, count: m[3] ? Number(m[3]) : 1 }
}

function groupFacts(lines: string[], firstSeen: Map<string, number>): Map<string, Map<string, number>> {
  const groups = new Map<string, Map<string, number>>()
  for (const kind of ["file", "command", "error"]) groups.set(kind, new Map())
  let order = 0
  for (const raw of lines) {
    const parsed = parseFactLine(raw.trim())
    if (!parsed) continue
    const target = stripCounter(parsed.target)
    if (!isSaneTarget(parsed.kind, target)) continue
    if (parsed.kind === "command" && !target.includes(" ")) continue
    const bucket = groups.get(parsed.kind)!
    const key = `${parsed.kind}\u0000${target}`
    if (!firstSeen.has(key)) firstSeen.set(key, order++)
    bucket.set(target, (bucket.get(target) ?? 0) + parsed.count)
  }
  return groups
}

function renderGroups(
  groups: Map<string, Map<string, number>>,
  firstSeenOf: (key: string) => number,
): string {
  const out: string[] = []
  for (const kind of ["file", "command", "error"]) {
    const entries = [...groups.get(kind)!.entries()].sort(
      (a, b) => (b[1] - a[1]) || firstSeenOf(`${kind}\u0000${a[0]}`) - firstSeenOf(`${kind}\u0000${b[0]}`),
    )
    for (const [target, count] of entries) {
      out.push(`- ${kind}: ${target}${count > 1 ? ` (${count}x)` : ""}`)
    }
  }
  return out.join("\n")
}

/**
 * Merges fact lines across cycles, curating and deduplicating by kind+target.
 */
export function mergeFacts(oldFacts: string, newFacts: string): string {
  const firstSeen = new Map<string, number>()
  const groups = groupFacts([...oldFacts.split("\n"), ...newFacts.split("\n")], firstSeen)
  return renderGroups(groups, (key) => firstSeen.get(key) ?? 0)
}

/**
 * Deterministic facts for a delta: the files, commands and errors the plugin
 * recorded itself. They survive a failed model call, so they never depend on
 * the narrative being produced.
 */
export function buildFacts(delta: Delta): string {
  const firstSeen = new Map<string, number>()
  const groups = groupFacts(delta.facts.split("\n"), firstSeen)
  return renderGroups(groups, (key) => firstSeen.get(key) ?? 0)
}

/**
 * Truncates the narrative so facts and narrative together fit the budget.
 * Facts come first: an oversized or missing narrative never displaces them.
 */
function fitNarrative(facts: string, narrative: string, narrativeBudget: number, combinedBudget: number): string {
  const trimmed = narrative.trim()
  if (!trimmed) return ""
  const prefix = facts ? `${facts}\n\n` : ""
  if (defaultTokenCounter(trimmed) <= narrativeBudget && defaultTokenCounter(prefix + trimmed) <= combinedBudget) {
    return trimmed
  }
  let lo = 0
  let hi = trimmed.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const slice = trimmed.slice(0, mid)
    if (defaultTokenCounter(slice) <= narrativeBudget && defaultTokenCounter(prefix + slice) <= combinedBudget) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return trimmed.slice(0, lo).trimEnd()
}

/**
 * Curated facts are rendered count-desc then first-seen-asc, so equal-count
 * entries keep their original insertion order (oldest first). A cap therefore
 * keeps the newest lines at the tail: the latest files, commands and errors
 * are the ones the next turn needs.
 */
function truncateFacts(facts: string, budget: number): string {
  if (defaultTokenCounter(facts) <= budget) return facts
  const lines = facts.split("\n")
  const kept: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    const cost = defaultTokenCounter(line) + 1
    if (used + cost > budget) break
    kept.unshift(line)
    used += cost
  }
  if (kept.length === 0) {
    // A6 fallback: when no whole line fits, prefix-cut only the NEWEST line
    // (tail of the fact set); older lines are dropped entirely.
    const lastLine = lines[lines.length - 1] ?? ""
    return truncateToTokenBudget(lastLine, budget)
  }
  const joined = kept.join("\n")
  return defaultTokenCounter(joined) > budget ? truncateToTokenBudget(joined, budget) : joined
}

function splitSummary(facts: string, narrative: string, budget: number): { narrative: string; summary: string } {
  const cap = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0
  const factsBudget = Math.floor(cap * FACTS_BUDGET_SHARE)
  const narrativeBudget = Math.floor(cap * NARRATIVE_BUDGET_SHARE)
  const summaryBudget = Math.floor(cap * SUMMARY_BUDGET_SHARE)
  const factsPart = truncateFacts(facts.trim(), factsBudget)
  const narrativePart = fitNarrative(factsPart, narrative.trim(), narrativeBudget, summaryBudget)
  const summary = [factsPart, narrativePart].filter(Boolean).join("\n\n")
  return { narrative: narrativePart, summary: defaultTokenCounter(summary) > summaryBudget ? truncateToTokenBudget(summary, summaryBudget) : summary }
}

/**
 * Joins the deterministic facts and the optional model narrative into a single
 * summary that never exceeds the budget. The two halves stay separate in the
 * record; only this display string carries both.
 */
export function mergeSummary(facts: string, narrative: string, budget: number): string {
  return splitSummary(facts, narrative, budget).summary
}

export function validateStoreInput(text: unknown, tags: unknown): string | null {
  const trimmed = typeof text === "string" ? text.trim() : ""
  if (!trimmed) return "Rejected: text is empty"
  if (!Array.isArray(tags)) return null
  if (tags.length > 16) return "Rejected: too many tags (max 16)"
  for (const tag of tags) {
    if (typeof tag !== "string") return "Rejected: invalid tag"
    if (tag.length > 64) return "Rejected: invalid tag"
    if (/[\x00-\x1f]/.test(tag)) return "Rejected: invalid tag"
  }
  return null
}

export function applyDelta(m: MemoryFile, delta: Delta, narrative: string, budget = 5000): void {
  if (m.consolidation.attemptId !== delta.attemptId) return
  // Narrative content is always redacted at rest, on every branch (redact("") === "").
  narrative = redact(narrative)
  const turnSet = new Set(delta.turnIds)
  const activitySet = new Set(delta.activityIds)
  m.pendingTurns = m.pendingTurns.filter((t) => !turnSet.has(t.turnId))
  m.pendingActivity = m.pendingActivity.filter((a) => !activitySet.has(a.id))
  const factsBudget = Math.floor((Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0) * FACTS_BUDGET_SHARE)
  m.summaryFacts = truncateFacts(mergeFacts(m.summaryFacts, buildFacts(delta)), factsBudget)
  const split = splitSummary(m.summaryFacts, narrative, budget)
  m.summaryNarrative = split.narrative
  m.summary = split.summary
  m.consolidation.consolidatedNotes = m.notes.length
  if (m.pendingTurns.length === 0 && m.pendingActivity.length === 0) {
    m.needsConsolidation = false
    if (m.consolidation) m.consolidation.pendingSince = null
  }
}
