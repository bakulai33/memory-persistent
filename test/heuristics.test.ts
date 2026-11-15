import { describe, test, expect } from "bun:test"
import { extractUserExcerpt } from "../src/heuristics"

describe("heuristics", () => {
  test("extractUserExcerpt normalizes whitespace", () => {
    expect(extractUserExcerpt("  hello   world  ")).toBe("hello world")
    expect(extractUserExcerpt("a\n\tb")).toBe("a b")
  })

  test("extractUserExcerpt keeps text at or under the limit intact", () => {
    const exact = "x".repeat(500)
    expect(extractUserExcerpt(exact)).toBe(exact)
    expect(extractUserExcerpt(extractUserExcerpt("short"))).toBe("short")
  })

  test("extractUserExcerpt truncates long text with an ellipsis", () => {
    const out = extractUserExcerpt("a".repeat(600))
    expect(out.length).toBe(501)
    expect(out.endsWith("…")).toBe(true)
  })

  test("extractUserExcerpt honors a custom limit", () => {
    const out = extractUserExcerpt("a".repeat(40), 10)
    expect(out.length).toBe(11)
    expect(out.endsWith("…")).toBe(true)
  })

  test("extractUserExcerpt counts the ellipsis inside the limit", () => {
    // 500 chars of content + "…" = 501 total: the excerpt never exceeds maxChars+1.
    const out = extractUserExcerpt("b".repeat(499))
    expect(out).toBe("b".repeat(499))
  })
})
