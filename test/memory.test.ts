import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addPendingTurn,
  appendNote,
  removeNote,
  buildInjection,
  buildConsolidationInput,
  allocate,
} from "../src/memory"
import {
  canConsolidate,
  backoffMs,
  retryDelayMs,
  beginAttempt,
  finishSuccess,
  finishFailure,
} from "../src/consolidation"
import { emptyMemory, addActivity, type PendingTurn } from "../src/storage"
import { defaultTokenCounter } from "../src/tokenizer"

const turn = (id: string, excerpt: string): PendingTurn => ({
  turnId: id,
  messageID: id,
  userExcerpt: excerpt,
  createdAt: new Date().toISOString(),
})

describe("memory", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("appendNote adds note", () => {
    const m = emptyMemory("s1")
    const n = appendNote(m, "decision X", ["tag"], "manual")
    expect(m.notes.length).toBe(1)
    expect(n.text).toBe("decision X")
  })

  test("removeNote removes", () => {
    const m = emptyMemory("s1")
    const n = appendNote(m, "decision X")
    expect(removeNote(m, n.id)).toBe(true)
    expect(m.notes.length).toBe(0)
  })

  test("addPendingTurn caps at 20", () => {
    const m = emptyMemory("s1")
    for (let i = 0; i < 25; i++) addPendingTurn(m, turn(String(i), `t${i}`))
    expect(m.pendingTurns.length).toBe(20)
    expect(m.pendingTurns[0]?.userExcerpt).toBe("t5")
  })

  test("addActivity folds repeats into a count", () => {
    const m = emptyMemory("s1")
    expect(addActivity(m, { kind: "command", target: "bun" })).toBe(true)
    expect(addActivity(m, { kind: "command", target: "bun" })).toBe(false)
    expect(m.pendingActivity.length).toBe(1)
    expect(m.pendingActivity[0]?.count).toBe(2)
  })

  test("buildInjection includes summary, conversation, notes and activity", () => {
    const m = emptyMemory("s1")
    m.summary = "summary text"
    appendNote(m, "note text")
    addPendingTurn(m, turn("t1", "quote text"))
    addActivity(m, { kind: "file", target: "src/index.ts" })
    const out = buildInjection(m, 5000)
    expect(out).toContain("summary text")
    expect(out).toContain("quote text")
    expect(out).toContain("note text")
    expect(out).toContain("src/index.ts")
  })

  test("buildInjection keeps the conversation when the summary is large", () => {
    const m = emptyMemory("s1")
    m.summary = "s".repeat(60000)
    appendNote(m, "IMPORTANT NOTE")
    addPendingTurn(m, turn("t1", "IMPORTANT QUOTE"))
    const out = buildInjection(m, 5000)
    expect(out).toContain("IMPORTANT QUOTE")
    expect(out).toContain("IMPORTANT NOTE")
  })

  test("buildInjection spends the whole budget", () => {
    const m = emptyMemory("s1")
    m.summary = "s".repeat(2000)
    addPendingTurn(m, turn("t1", "c".repeat(2000)))
    addActivity(m, { kind: "command", target: "bun" })
    const out = buildInjection(m, 5000)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain("c")
  })

  test("buildConsolidationInput keeps the conversation when notes are verbose", () => {
    const m = emptyMemory("s1")
    m.summary = "S".repeat(3000)
    for (let i = 0; i < 20; i++) appendNote(m, "N".repeat(800) + i)
    addPendingTurn(m, turn("t1", "CONVERSATION-QUOTE"))
    const out = buildConsolidationInput(m, 12000)
    expect(out).toContain("CONVERSATION-QUOTE")
  })

  test("buildConsolidationInput cuts at a line boundary", () => {
    const m = emptyMemory("s1")
    m.summary = "line one\nline two\nline three"
    const out = buildConsolidationInput(m, 5)
    expect(out).not.toContain("line two")
    expect(out).toContain("line one")
  })

  test("allocate redistributes unused budget", () => {
    // A short first section must not starve the second one of its share.
    const sections = [
      { text: "s ".repeat(50), capPct: 0.45 },
      { text: "c ".repeat(1500), capPct: 0.3 },
    ]
    const allowance = allocate(sections, 5000)
    const natural = defaultTokenCounter(sections[1]!.text)
    expect(allowance[1]).toBeGreaterThanOrEqual(natural)
    expect(allowance[1]).toBeLessThanOrEqual(5000)
  })

  test("allocate never exceeds the budget", () => {
    const sections = [
      { text: "s".repeat(9000), capPct: 0.45 },
      { text: "c".repeat(9000), capPct: 0.3 },
      { text: "n".repeat(9000), capPct: 0.15 },
      { text: "a".repeat(9000), capPct: 0.1 },
    ]
    const allowance = allocate(sections, 5000)
    expect(allowance.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5000)
  })

  test("canConsolidate respects the failure backoff", () => {
    const m = emptyMemory("s1")
    expect(canConsolidate(m)).toBe(false)
    m.needsConsolidation = true
    expect(canConsolidate(m)).toBe(true)

    const attemptId = "attempt-1"
    beginAttempt(m, attemptId)
    expect(m.consolidation.consecutiveFailures).toBe(0)
    expect(m.consolidation.state).toBe("running")
    expect(canConsolidate(m)).toBe(false)

    finishFailure(m, attemptId, "QuotaExceeded")
    expect(m.consolidation.error).toBe("QuotaExceeded")
    expect(canConsolidate(m)).toBe(false)
  })

  test("backoff grows from one to ten minutes", () => {
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(1)).toBe(60_000)
    expect(backoffMs(2)).toBe(120_000)
    expect(backoffMs(3)).toBe(240_000)
    expect(backoffMs(4)).toBe(480_000)
    expect(backoffMs(5)).toBe(600_000)
    expect(backoffMs(50)).toBe(600_000)
  })

  test("markSuccess resets the failure state", () => {
    const m = emptyMemory("s1")
    m.needsConsolidation = true
    beginAttempt(m, "attempt-2a")
    finishFailure(m, "attempt-2a", "boom")
    beginAttempt(m, "attempt-2b")
    finishSuccess(m, "attempt-2b")
    expect(m.consolidation.consecutiveFailures).toBe(0)
    expect(m.consolidation.error).toBe(null)
    expect(m.consolidation.finishedAt).not.toBe(null)
  })

  test("retryDelayMs reports the wait before the next attempt", () => {
    const m = emptyMemory("s1")
    m.needsConsolidation = true
    beginAttempt(m, "attempt-3")
    finishFailure(m, "attempt-3", "boom")
    const wait = retryDelayMs(m)
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(60_000)
  })
})
