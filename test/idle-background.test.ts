import { describe, test, expect } from "bun:test"
import { emptyMemory } from "../src/storage"
import { shouldDefer, noteDeferral } from "../src/consolidation"

describe("idle background deferral", () => {
  test("shouldDefer is true when background work is outstanding and nothing deferred yet", () => {
    const m = emptyMemory("s1")
    expect(shouldDefer(m, 1)).toBe(true)
  })

  test("shouldDefer is false when there is no background work", () => {
    const m = emptyMemory("s1")
    expect(shouldDefer(m, 0)).toBe(false)
  })

  test("shouldDefer is false after 3 deferrals (fallback)", () => {
    const m = emptyMemory("s1")
    m.consolidation.deferrals = 3
    expect(shouldDefer(m, 1)).toBe(false)
  })

  test("shouldDefer is false once 15 minutes have elapsed (fallback)", () => {
    const m = emptyMemory("s1")
    m.consolidation.deferrals = 1
    const now = Date.now()
    m.consolidation.deferredSince = new Date(now - 20 * 60_000).toISOString()
    expect(shouldDefer(m, 1, now)).toBe(false)
  })

  test("noteDeferral increments deferrals and sets deferredSince on first call", () => {
    const m = emptyMemory("s1")
    const first = Date.now() - 5_000
    noteDeferral(m, first)
    expect(m.consolidation.deferrals).toBe(1)
    expect(m.consolidation.deferredSince).toBe(new Date(first).toISOString())

    const second = first + 1_000
    noteDeferral(m, second)
    expect(m.consolidation.deferrals).toBe(2)
    // deferredSince is pinned to the first deferral
    expect(m.consolidation.deferredSince).toBe(new Date(first).toISOString())
  })
})