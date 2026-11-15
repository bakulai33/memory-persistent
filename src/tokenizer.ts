import { countTokens } from "gpt-tokenizer"

export type TokenCounter = (text: string) => number

export const defaultTokenCounter: TokenCounter = (text: string): number => {
  // A non-string caller would leave `text.length` undefined in the fallback
  // (NaN poisoning every budget sum), so coerce once at the boundary.
  const s = typeof text === "string" ? text : String(text)
  try {
    return countTokens(s)
  } catch {
    return Math.ceil(s.length / 4)
  }
}

export function truncateToTokenBudget(text: string, budget: number, counter: TokenCounter = defaultTokenCounter): string {
  if (counter(text) <= budget) return text
  // Binary search by character length.
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (counter(text.slice(0, mid)) <= budget) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

export function capText(text: string, budget: number, counter: TokenCounter = defaultTokenCounter): string {
  return truncateToTokenBudget(text, budget, counter)
}
