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