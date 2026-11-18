import { describe, test, expect } from "bun:test"
import { buildFacts, mergeFacts } from "../src/memory"

const delta = (facts: string) =>
  ({ attemptId: "a", turnIds: [], activityIds: [], turns: [], notes: [], summary: "", facts } as any)

describe("facts", () => {
  test("varianCounterMenyatu", () => {
    const out = buildFacts(delta("- command: bun test (3x)\n- command: bun test\n- command: bun test (2x)"))
    const lines = out.split("\n").filter(Boolean)
    expect(lines.length).toBe(1)
    expect(lines[0]).toBe("- command: bun test (6x)")
  })

  test("binaryPolosDibuang", () => {
    const out = buildFacts(delta("- command: python3\n- command: git commit"))
    expect(out).not.toContain("python3")
    expect(out).toContain("git commit")
  })

  test("errorMultiBarisJadiSatuBaris", () => {
    const out = buildFacts(delta("- error: a\nb\nc"))
    expect(out.split("\n").filter(Boolean).length).toBe(1)
  })

  test("fileBerkontaminasiDibuang", () => {
    const out = buildFacts(delta("- file: /a/b.ts\noldString=\"secret\""))
    expect(out).not.toContain("oldString")
  })

  test("urutanFileLaluCommandLaluError", () => {
    const out = buildFacts(delta("- command: git commit\n- error: boom\n- file: /a.ts"))
    expect(out.split("\n").map((l) => l.split(":")[0])).toEqual(["- file", "- command", "- error"])
  })

  test("idempoten", () => {
    const once = buildFacts(delta("- command: bun test (3x)\n- file: /a.ts"))
    const twice = buildFacts(delta(once))
    expect(twice).toBe(once)
  })

  test("mergeFactsIdempoten", () => {
    const a = mergeFacts("- command: bun test (3x)", "- command: bun test")
    const b = mergeFacts(a, "")
    expect(b).toBe(a)
    expect(a).toBe("- command: bun test (4x)")
  })
})

describe("single-word command facts (T4.4)", () => {
  test("make berulang tercatat sebagai (2x)", () => {
    // Two bare `make` invocations aggregate into one repeated fact: the
    // repetition itself is the signal the model should remember.
    const out = buildFacts(delta("- command: make\n- command: make"))
    expect(out).toBe("- command: make (2x)")
  })

  test("single-word sekali tetap dibuang", () => {
    // One bare invocation without a subcommand says nothing about WHAT ran.
    expect(buildFacts(delta("- command: make"))).toBe("")
  })

  test("python3 polos tetap dibuang (regresi facts.test.ts:16)", () => {
    const out = buildFacts(delta("- command: python3\n- command: make\n- command: make"))
    expect(out).not.toContain("python3")
    expect(out).toContain("- command: make (2x)")
  })

  test("idempoten lewat counter", () => {
    const once = buildFacts(delta("- command: make (2x)"))
    expect(buildFacts(delta(once))).toBe(once)
  })

  test("mergeFacts menyatukan make polos berulang", () => {
    expect(mergeFacts("- command: make", "- command: make")).toBe("- command: make (2x)")
  })
})