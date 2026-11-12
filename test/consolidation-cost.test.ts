import { describe, test, expect } from "bun:test"
import { addActivity, emptyMemory, type PendingTurn } from "../src/storage"
import {
  addPendingTurn,
  buildConsolidationPrompt,
  collectDelta,
  defaultConsolidationMode,
  estimatePromptTokens,
  retryOnce,
} from "../src/memory"
import { beginAttempt } from "../src/consolidation"

const turn = (id: string, excerpt: string): PendingTurn => ({
  turnId: id,
  messageID: id,
  userExcerpt: excerpt,
  createdAt: new Date().toISOString(),
})

describe("consolidation cost", () => {
  test("a four-turn, nine-activity delta stays below 4000 prompt tokens", () => {
    const m = emptyMemory("cost-session")
    beginAttempt(m, "cost-attempt")
    addPendingTurn(m, turn("t1", "the user wants the idle hook to stop sending session history"))
    addPendingTurn(m, turn("t2", "we measured 54748 tokens of history on a 635 message session"))
    addPendingTurn(m, turn("t3", "the stateless generator takes a prompt and an optional model"))
    addPendingTurn(m, turn("t4", "remember that the consolidation state machine must still record failures"))
    for (let i = 1; i <= 9; i++) {
      addActivity(m, { kind: "file", target: `src/module-${i}.ts` })
    }

    const prompt = buildConsolidationPrompt(collectDelta(m), 4500)

    // The prompt must still carry the material, not just come in under budget.
    expect(prompt).toContain("the stateless generator takes a prompt")
    for (let i = 1; i <= 9; i++) expect(prompt).toContain(`src/module-${i}.ts`)
    expect(estimatePromptTokens(prompt)).toBeLessThan(4000)
  })

  test("the default consolidation path is stateless", () => {
    expect(defaultConsolidationMode()).toBe("stateless")
  })
})

describe("retryOnce", () => {
  test("retries exactly once after a failure", async () => {
    const calls: number[] = []
    const value = await retryOnce(async () => {
      calls.push(calls.length + 1)
      if (calls.length === 1) throw new Error("first attempt failed")
      return "second attempt"
    })
    expect(value).toBe("second attempt")
    expect(calls).toHaveLength(2)
  })

  test("gives up after two failures", async () => {
    let calls = 0
    await expect(
      retryOnce(async () => {
        calls += 1
        throw new Error(`attempt ${calls}`)
      }),
    ).rejects.toThrow("attempt 2")
    expect(calls).toBe(2)
  })

  test("does not retry a success", async () => {
    let calls = 0
    const value = await retryOnce(async () => {
      calls += 1
      return "ok"
    })
    expect(value).toBe("ok")
    expect(calls).toBe(1)
  })
})
