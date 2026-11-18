import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildInjection,
  buildConsolidationPrompt,
  SUMMARY_BUDGET_SHARE,
  SUMMARY_SHARE,
  applyDelta,
  appendNote,
  capLinesByChars,
  capTextByChars,
  NOTES_CAP,
  previewNote,
  type Delta,
} from "../src/memory"
import { defaultTokenCounter } from "../src/tokenizer"
import { emptyMemory, addActivity, readMemory, writeMemory } from "../src/storage"
import { beginAttempt } from "../src/consolidation"
import { collectDelta } from "../src/memory"
import { logPath } from "../src/log"

describe("consolidation warning in the injection (T4.6)", () => {
  test("a failed consolidation is flagged with its error", () => {
    const m = emptyMemory("ses_warn_fail")
    m.summaryFacts = "- command: bun test"
    m.consolidation.state = "failed"
    m.consolidation.error = "boom"
    const out = buildInjection(m, 500)
    expect(out).toContain("last consolidation failed")
    expect(out).toContain("boom")
  })

  test("a stale attempt reads as failed and is flagged (T4.6)", () => {
    // recoverStaleAttempt marks a timed-out attempt "stale attempt (timeout)";
    // the injection must surface it so the model knows the summary is old.
    const m = emptyMemory("ses_warn_stale")
    m.summaryFacts = "- command: bun test"
    m.consolidation.state = "failed"
    m.consolidation.error = "stale attempt (timeout)"
    const out = buildInjection(m, 500)
    expect(out).toContain("last consolidation failed")
    expect(out).toContain("stale attempt")
  })

  test("a healthy memory carries no warning", () => {
    const m = emptyMemory("ses_warn_ok")
    m.summaryFacts = "- command: bun test"
    const out = buildInjection(m, 500)
    expect(out).not.toContain("Warning")
  })
})

describe("B1 own wins, inherited per-block truncated (Task 3.3)", () => {
  test("own facts survive; inherited truncated from head under small budget (B1)", () => {
    const m = emptyMemory("ses_own")
    // Own facts long enough that tail-keep over the COMBINED text would cut
    // into own's HEAD — inverting to per-block must keep all own lines.
    m.summaryFacts = Array.from({ length: 8 }, (_, i) => `- file: src/own_module_${i}.ts`).join("\n")
    m.summaryFactsInherited = Array.from({ length: 8 }, (_, i) => `- file: src/inherited_${i}.ts`).join("\n")
    const out = buildInjection(m, 300)
    for (let i = 0; i < 8; i++) {
      expect(out).toContain(`src/own_module_${i}.ts`)
    }
    // Inherited tail must be visibly truncated, but the depth-LABEL survives
    // (label is the HEAD of the inherited block, kept via keep-head trunc).
    const i0 = out.indexOf("src/inherited_0.ts")
    const i7 = out.indexOf("src/inherited_7.ts")
    // At least one inherited tail member is dropped under the budget.
    expect(i0 === -1 || i7 === -1).toBe(true)
  })

  test("fallback: newest line prefix-cut when no whole line fits (A6)", () => {
    const m = emptyMemory("ses_fb")
    // Both lines live in the SAME fact text; the newest one is so big that no
    // whole line fits → only the NEWEST line survives, as a prefix.
    m.summaryFacts = `- command: old_tail\n- command: ${"a".repeat(4000)}`
    const out = buildInjection(m, 200)
    // old_tail (older line, same block) is fully dropped, not head-trimmed.
    expect(out).not.toContain("old_tail")
    // some "a…" prefix of the newest survives
    expect(out).toContain("aaa")
  })
})

describe("budget alignment", () => {
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

  test("SUMMARY_SHARE equals SUMMARY_BUDGET_SHARE", () => {
    expect(SUMMARY_SHARE).toBe(SUMMARY_BUDGET_SHARE)
    expect(SUMMARY_BUDGET_SHARE).toBe(0.5)
  })

  test("buildInjection with 10000-token summaryFacts and budget 5000 keeps summary section <= 2500 tokens", () => {
    const m = emptyMemory("s1")
    m.summaryFacts = "w".repeat(10000 * 4)
    const out = buildInjection(m, 5000)
    // only summary present
    expect(defaultTokenCounter(out)).toBeLessThanOrEqual(2500)
  })

  test("written summary <= floor(budget * 0.5) tokens", () => {
    const budget = 5000
    const m = emptyMemory("s2")
    m.summaryFacts = Array.from({ length: 300 }, (_, i) => `- file: src/legacy-${i}.ts`).join("\n")
    beginAttempt(m, "attempt-budget")
    addActivity(m, { kind: "error", target: "boom" })
    const delta = collectDelta(m)
    applyDelta(m, delta, "long narrative ".repeat(1000), budget)
    expect(defaultTokenCounter(m.summary)).toBeLessThanOrEqual(Math.floor(budget * 0.5))
  })

  test("injeksiTidakMelebihiBudget", () => {
    // Sections DIELONGI dari cap-nya agar jalur `total > usable` di allocate()
    // dan penskalaan + reservasi separator diuji dengan serius.
    const m = emptyMemory("ses_budget")
    // facts cap = 0.35 * budget; untuk budget 1000 => 350 token. Buatkan 3000 token.
    m.summaryFacts = Array.from({ length: 400 }, (_, i) => `- command: bun test number ${i} with padding text`).join("\n")
    // activity cap = 0.10 * budget; untuk budget 1000 => 100 token. Buatkan 2000 token.
    m.pendingActivity = Array.from({ length: 400 }, (_, i) => ({ id: `a${i}`, kind: "command", target: `cmd ${i} with some padding text here`, command: "c", count: 1, createdAt: "" } as any))
    // conversation cap = 0.30 * budget; untuk budget 1000 => 300 token. Buatkan 2000 token.
    m.pendingTurns = Array.from({ length: 20 }, (_, i) => ({ turnId: `t${i}`, messageID: `m${i}`, userExcerpt: "word ".repeat(200), createdAt: "", tier: "likely" } as any))
    // notes cap = 0.15 * budget; untuk budget 1000 => 150 token. Buatkan 1500 token.
    m.notes = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, text: "note text ".repeat(300), tags: [], createdAt: "", source: "manual" } as any))

    for (const budget of [500, 1000, 5000]) {
      const tokens = defaultTokenCounter(buildInjection(m, budget))
      expect(tokens).toBeLessThanOrEqual(budget)
    }
  })

  test("sectionKecilTidakTerpotong", () => {
    const m = emptyMemory("ses_small")
    m.summary = "s".repeat(60000)
    m.pendingTurns = [{ turnId: "t1", messageID: "m1", userExcerpt: "IMPORTANT QUOTE", createdAt: "", tier: "likely" } as any]
    m.notes = [{ id: "n1", text: "IMPORTANT NOTE", tags: [], createdAt: "", source: "manual" } as any]
    const out = buildInjection(m, 5000)
    expect(out).toContain("IMPORTANT QUOTE")
    expect(out).toContain("IMPORTANT NOTE")
  })

  test("buildInjection includes summaryFacts and summaryNarrative", () => {
    const m = emptyMemory("s3")
    m.summaryFacts = "FACTS-MARKER-XYZ"
    m.summaryNarrative = "NARRATIVE-MARKER-XYZ"
    const out = buildInjection(m, 5000)
    expect(out).toContain("FACTS-MARKER-XYZ")
    expect(out).toContain("NARRATIVE-MARKER-XYZ")
  })

  test("narrative survives when facts fill their slice", () => {
    const m = emptyMemory("s4")
    m.summaryFacts = Array.from({ length: 200 }, (_, i) => `- file: src/module-${i}.ts`).join("\n")
    m.summaryNarrative = "NARRATIVE-SURVIVES-MARKER"
    const out = buildInjection(m, 5000)
    expect(out).toContain("NARRATIVE-SURVIVES-MARKER")
  })
})

describe("pre-tokenization caps + notes cap (T1.1)", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-cap-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  const bigMemory = (sessionID: string) => {
    const m = emptyMemory(sessionID)
    for (let i = 0; i < 200; i++) {
      m.notes.push({ id: `n${i}`, text: `note ${i} ${"x".repeat(8000)}`, tags: [], createdAt: "", source: "manual" })
    }
    m.pendingTurns = Array.from({ length: 20 }, (_, i) => ({
      turnId: `t${i}`,
      messageID: `m${i}`,
      userExcerpt: "turn ".repeat(200),
      createdAt: "",
      tier: "likely",
    } as any))
    m.pendingActivity = Array.from({ length: 40 }, (_, i) => ({
      id: `a${i}`,
      kind: "command",
      target: `cmd${i}`,
      command: "c",
      count: 1,
      createdAt: "",
    } as any))
    return m
  }

  test("injection 200x8KB tetap <= budget token (guard output)", () => {
    const out = buildInjection(bigMemory("ses_big"), 5000)
    expect(defaultTokenCounter(out)).toBeLessThanOrEqual(5000)
  })

  test("previewNote memotong note 8KB ke <= 500 karakter", () => {
    const preview = previewNote(`MARKER-HEAD ${"x".repeat(8000)}`, 500)
    expect(preview.length).toBeLessThanOrEqual(500)
    expect(preview.startsWith("MARKER-HEAD")).toBe(true)
  })

  test("capTextByChars: invariant panjang, mode head/tail, teks pendek tak berubah", () => {
    const text = "abcdef".repeat(1000)
    expect(capTextByChars(text, 100, "head")).toBe(text.slice(0, 100))
    const tail = capTextByChars(text, 100, "tail")
    expect(tail).toBe(text.slice(-100))
    expect(capTextByChars(text, 10000)).toBe(text)
  })

  test("capLinesByChars: baris utuh <= maxChars, mode head dan tail", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${"-".repeat(50)}`)
    const head = capLinesByChars(lines, 200, "head")
    expect(head.join("\n").length).toBeLessThanOrEqual(200)
    expect(head[0]).toBe(lines[0])
    const tail = capLinesByChars(lines, 200, "tail")
    expect(tail.join("\n").length).toBeLessThanOrEqual(200)
    expect(tail[tail.length - 1]).toBe(lines[lines.length - 1])
  })

  test("injection memakai preview note 500 char, bukan teks penuh", () => {
    const m = emptyMemory("ses_preview")
    m.notes = [{ id: "n1", text: `MARKER-HEAD ${"y".repeat(8000)}`, tags: [], createdAt: "", source: "manual" } as any]
    const out = buildInjection(m, 5000)
    expect(out).toContain("MARKER-HEAD")
    // Preview 500 char hanya menyisakan ~496 'y'; teks penuh menyisakan ribuan.
    expect(out.includes("y".repeat(600))).toBe(false)
  })

  test("prompt konsolidasi <= budget dan memuat instruksi + facts terbaru", () => {
    const m = bigMemory("ses_prompt")
    m.pendingActivity = Array.from({ length: 40 }, (_, i) => ({
      id: `a${i}`,
      kind: "command",
      target: `TAILFACT-${i}`,
      command: "c",
      count: 1,
      createdAt: "",
    } as any))
    const prompt = buildConsolidationPrompt(collectDelta(m), 4500)
    expect(defaultTokenCounter(prompt)).toBeLessThanOrEqual(4500)
    expect(prompt).toContain("Tulis ringkasan final di bawah 4500 token")
    expect(prompt).toContain("TAILFACT-39")
  })

  test("appendNote membatasi NOTES_CAP=200, evict tertua, log note-evicted", () => {
    expect(NOTES_CAP).toBe(200)
    const m = emptyMemory("ses_cap")
    for (let i = 0; i < 201; i++) appendNote(m, `CAPNOTE-${i}`)
    expect(m.notes).toHaveLength(200)
    expect(m.notes.some((n) => n.text.includes("CAPNOTE-0"))).toBe(false)
    expect(m.notes[m.notes.length - 1]!.text).toContain("CAPNOTE-200")
    expect(readFileSync(logPath(), "utf8")).toContain("note-evicted")
  })

  test("write path cap: legacy 300 notes -> 200 tersimpan + consolidatedNotes di-clamp", async () => {
    const m = emptyMemory("ses_legacy300")
    for (let i = 0; i < 300; i++) {
      m.notes.push({ id: `n${i}`, text: `LEG-${i}`, tags: [], createdAt: "", source: "manual" })
    }
    m.consolidation.consolidatedNotes = 250
    await writeMemory("ses_legacy300", m)
    const loaded = await readMemory("ses_legacy300")
    expect(loaded.notes).toHaveLength(200)
    expect(loaded.notes.some((n) => n.text === "LEG-0")).toBe(false)
    expect(loaded.notes.some((n) => n.text === "LEG-299")).toBe(true)
    expect(loaded.consolidation.consolidatedNotes).toBeLessThanOrEqual(NOTES_CAP)
  })
})