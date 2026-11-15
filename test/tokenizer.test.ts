import { describe, test, expect } from "bun:test"
import { defaultTokenCounter, truncateToTokenBudget, capText } from "../src/tokenizer"

describe("tokenizer", () => {
  test("defaultTokenCounter counts real tokens", () => {
    expect(defaultTokenCounter("hello world")).toBe(2)
    expect(defaultTokenCounter("")).toBe(0)
    expect(defaultTokenCounter("one two three four five")).toBe(5)
  })

  test("truncateToTokenBudget keeps text within budget", () => {
    const text = "one two three four five"
    expect(truncateToTokenBudget(text, 5)).toBe(text)
    expect(defaultTokenCounter(truncateToTokenBudget(text, 2))).toBeLessThanOrEqual(2)
  })

  test("truncateToTokenBudget respects an injected counter", () => {
    // A counter that charges 1 token per CHARACTER: 5-char budget keeps 5 chars.
    const counter = (t: string) => t.length
    expect(truncateToTokenBudget("abcdefghij", 5, counter)).toBe("abcde")
  })

  test("truncateToTokenBudget returns empty for a zero budget", () => {
    expect(truncateToTokenBudget("hello", 0)).toBe("")
  })

  test("capText is the truncation alias", () => {
    const counter = (t: string) => t.length
    expect(capText("abcdefghij", 3, counter)).toBe("abc")
    expect(capText("hi", 10, counter)).toBe("hi")
  })

  test("defaultTokenCounter falls back to length/4 when the tokenizer throws", () => {
    // gpt-tokenizer throws on non-string input; exercise the catch via any-cast.
    const weird = 12345 as unknown as string
    expect(defaultTokenCounter(weird)).toBeGreaterThan(0)
  })
})
