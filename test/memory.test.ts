import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addPendingTurn,
  appendNote,
  removeNote,
  buildInjection,
  buildRecallPayload,
  buildListPayload,
  buildConsolidationInput,
  allocate,
  validateStoreInput,
  PAYLOAD_CAP_BYTES,
} from "../src/memory"
import {
  canConsolidate,
  backoffMs,
  retryDelayMs,
  beginAttempt,
  finishSuccess,
  finishFailure,
} from "../src/consolidation"
import { emptyMemory, addActivity, type PendingTurn, type MemoryNote, writeMemory, readMemory, updateMemory } from "../src/storage"
import { copyMemory } from "../src/memory"
import { defaultTokenCounter } from "../src/tokenizer"

const turn = (id: string, excerpt: string): PendingTurn => ({
  turnId: id,
  messageID: id,
  userExcerpt: excerpt,
  createdAt: new Date().toISOString(),
})

/** Catatan warisan sintetis (bentuk sama seperti snapshot parent di buildSnapshot). */
const inheritedNote = (id: string, text: string): MemoryNote => ({
  id,
  text,
  tags: [],
  createdAt: new Date().toISOString(),
  source: "manual",
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

  test("appendNote redacts secrets in tags, keeps plain tags (T2.2)", () => {
    const m = emptyMemory("s_tags")
    const n = appendNote(m, "deploy note", ["deploy", "token=npm_abcdefghijklmnopqrstuvwxyz012345678"], "manual")
    expect(n.tags).toContain("deploy")
    expect(n.tags.join(" ")).not.toContain("npm_abcdefghijklmnopqrstuvwxyz012345678")
    expect(n.tags.join(" ")).toContain("[REDACTED]")
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

  test("injeksiMelabeliFactsWarisan", async () => {
    const parent = emptyMemory("ses_parent")
    parent.summaryFacts = "- command: bun test (17x)"
    await writeMemory("ses_parent", parent)
    await copyMemory("ses_parent", "ses_child")

    const child = await readMemory("ses_child")
    const out = buildInjection(child, 5000)
    expect(out).toContain("Inherited from parent session:")
    expect(out).toContain("bun test")
  })

  test("injeksiSeksiNotes: own dulu lalu blok inherited berlabel", () => {
    const m = emptyMemory("s_notes")
    appendNote(m, "own decision")
    appendNote(m, "second own")
    m.notesInherited = [inheritedNote("i1", "inherited one"), inheritedNote("i2", "inherited two")]
    const out = buildInjection(m, 5000)
    // satu seksi: header Manual notes, own lines, lalu sub-label exact
    expect(out).toContain("Manual notes:\n- own decision\n- second own\nManual notes (inherited):\n- inherited one\n- inherited two")
    // own sebelum inherited
    expect(out.indexOf("- own decision")).toBeLessThan(out.indexOf("Manual notes (inherited):"))
    // urut tersimpan
    expect(out.indexOf("- inherited one")).toBeLessThan(out.indexOf("- inherited two"))
  })

  test("injeksiSeksiNotes: header Manual notes tetap saat hanya inherited", () => {
    const m = emptyMemory("s_notes2")
    m.notesInherited = [inheritedNote("i1", "inherited only")]
    const out = buildInjection(m, 5000)
    expect(out).toContain("Manual notes:\nManual notes (inherited):\n- inherited only")
  })

  test("copyMemory waits for an in-flight parent update before reading (I5)", async () => {
    await writeMemory("cm_parent", emptyMemory("cm_parent"))
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const update = updateMemory("cm_parent", async (m) => {
      order.push("update-start")
      await gate
      m.summary = "held"
      order.push("update-end")
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const copy = copyMemory("cm_parent", "cm_child").then(() => {
      order.push("copy-read")
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // selama update memegang lock, copyMemory belum membaca di luar lock
    expect(order).toEqual(["update-start"])
    release()
    await Promise.all([update, copy])
    expect(order).toEqual(["update-start", "update-end", "copy-read"])
  })

  test("copyMemory to itself is a no-op", async () => {
    const parent = emptyMemory("cm_same")
    appendNote(parent, "keep me")
    await writeMemory("cm_same", parent)

    await copyMemory("cm_same", "cm_same")

    const after = await readMemory("cm_same")
    expect(after.notes.length).toBe(1)
    expect(after.parentSnapshotFrom).toBeNull()
    expect(after.inheritedDepth).toBe(0)
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

  test("injeksiMenandaiNarasiSebagaiUnverified", () => {
    const m = emptyMemory("ses_unv")
    m.summaryFacts = "- file: /a.ts"
    m.summaryNarrative = "Test suite lulus dengan 12 test."
    const inj = buildInjection(m, 5000)
    expect(inj).toContain("unverified")
    expect(inj).toContain("model-generated")
    // fakta deterministik TIDAK diberi label
    expect(inj).not.toContain("unverified\n- file")
  })

  test("payloadRecallMenyertakanPenandaNarasi", () => {
    const m = emptyMemory("ses_recall")
    m.summaryFacts = "- file: /a.ts"
    m.summaryNarrative = "Test suite lulus dengan 12 test."
    const payload = buildRecallPayload(m, 5000)
    expect(payload.summaryNarrativeVerified).toBe(false)
    expect(payload.injection).toContain("unverified")
  })

  test("recallPayload 200x8KB <= 32KB, truncated, totalNotes, preview 500", () => {
    const m = emptyMemory("ses_paybig")
    for (let i = 0; i < 200; i++) {
      m.notes.push({ id: `n${i}`, text: `note ${i} ${"x".repeat(8000)}`, tags: [], createdAt: "", source: "manual" })
    }
    const payload = buildRecallPayload(m, 5000)
    const json = JSON.stringify(payload)
    expect(json.length).toBeLessThanOrEqual(PAYLOAD_CAP_BYTES)
    expect(payload.truncated).toBe(true)
    expect(payload.totalNotes).toBe(200)
    expect(payload.notes[0]!.text.length).toBeLessThanOrEqual(500)
  })

  test("recallPayload note pendek tetap utuh dan tidak truncated", () => {
    const m = emptyMemory("ses_payshort")
    appendNote(m, "catatan pendek", [], "manual")
    const payload = buildRecallPayload(m, 5000)
    expect(payload.notes[0]!.text).toBe("catatan pendek")
    expect(payload.truncated).toBe(false)
    expect(payload.totalNotes).toBe(1)
  })

  test("listPayload 200x8KB <= 32KB, truncated, totalNotes, preview", () => {
    const m = emptyMemory("ses_listbig")
    for (let i = 0; i < 200; i++) {
      m.notes.push({ id: `n${i}`, text: `note ${i} ${"y".repeat(8000)}`, tags: [], createdAt: "", source: "manual" })
    }
    const payload = buildListPayload(m)
    const json = JSON.stringify(payload)
    expect(json.length).toBeLessThanOrEqual(PAYLOAD_CAP_BYTES)
    expect(payload.truncated).toBe(true)
    expect(payload.totalNotes).toBe(200)
    expect(payload.notes[0]!.preview.length).toBeLessThanOrEqual(500)
    expect(Object.keys(payload.notes[0]!).sort()).toEqual(["id", "preview", "tags"])
  })

  test("listPayload note pendek tetap utuh", () => {
    const m = emptyMemory("ses_listshort")
    appendNote(m, "n1", ["x"], "manual")
    appendNote(m, "n2", [], "manual")
    const payload = buildListPayload(m)
    expect(payload.notes.map((n: any) => n.preview)).toEqual(["n1", "n2"])
    expect(payload.truncated).toBe(false)
    expect(payload.totalNotes).toBe(2)
  })

  test("storeMenolakTeksKosong", () => {
    expect(validateStoreInput("", [])).toBe("Rejected: text is empty")
    expect(validateStoreInput("   ", [])).toBe("Rejected: text is empty")
    expect(validateStoreInput(undefined, [])).toBe("Rejected: text is empty")
    expect(validateStoreInput("catatan yang valid", [])).toBeNull()
  })

  test("storeMenolakTagBerlebihan", () => {
    expect(validateStoreInput("ok", Array.from({ length: 17 }, () => "t"))).toBe("Rejected: too many tags (max 16)")
    expect(validateStoreInput("ok", ["x".repeat(65)])).toBe("Rejected: invalid tag")
    expect(validateStoreInput("ok", ["bad\u0000tag"])).toBe("Rejected: invalid tag")
  })

  test("storeMenolakTagBukanArray (T4.1)", () => {
    expect(validateStoreInput("ok", "x")).toBe("Rejected: tags must be an array")
    expect(validateStoreInput("ok", 42)).toBe("Rejected: tags must be an array")
    expect(validateStoreInput("ok", { a: 1 })).toBe("Rejected: tags must be an array")
    // Omitted tags stay valid — the store coerces them to [] at the append site.
    expect(validateStoreInput("ok", undefined)).toBeNull()
    expect(validateStoreInput("ok", null)).toBeNull()
  })
})

describe("B1b fallback & B2 depth labels (Task 3.3)", () => {
  test("depth 3 → 'Inherited from 3 earlier sessions:'", () => {
    const m = emptyMemory("ses_depth3")
    m.summaryFactsInherited = "- command: hello_world"
    m.inheritedDepth = 3
    const out = buildInjection(m, 5000)
    expect(out).toContain("Inherited from 3 earlier sessions:")
    expect(out).not.toContain("Inherited from parent session:")
  })

  test("absent inheritedDepth → 'Inherited from parent session:' (A15)", () => {
    const m = emptyMemory("ses_parent_unset")
    m.summaryFactsInherited = "- command: old_fact"
    delete (m as { inheritedDepth?: number }).inheritedDepth
    const out = buildInjection(m, 5000)
    expect(out).toContain("Inherited from parent session:")
  })

  test("emoji/multibyte at budget boundary: summary section stays within summaryBudget", () => {
    // Review Focus #1: multi-byte tokens on the inherited side still stay inside
    // the summary section's budget — either dropped or cut, never overshooting.
    const m = emptyMemory("ses_emoji")
    m.summaryFacts = Array.from({ length: 40 }, (_, i) => `- file: own_${i}_🎉🚀🔥`).join("\n")
    m.summaryFactsInherited = Array.from({ length: 40 }, (_, i) => `- file: inh_${i}_🌊🌶️🎬`).join("\n")
    const out = buildInjection(m, 500)
    const summaryStart = out.indexOf("Summary:")
    expect(summaryStart).toBeGreaterThanOrEqual(0)
    const afterHeader = out.slice(summaryStart)
    const summaryBody = afterHeader.split(/\n\n(?=[A-Za-z]+:)/)[0] ?? afterHeader
    const summaryBudget = Math.floor(500 * 0.5) // SUMMARY_BUDGET_SHARE in src/memory.ts
    expect(defaultTokenCounter(summaryBody)).toBeLessThanOrEqual(summaryBudget)
  })
})
