import { countTokens } from "gpt-tokenizer"

export type TokenCounter = (text: string) => number

export const defaultTokenCounter: TokenCounter = (text: string): number => {
  try {
    return countTokens(text)
  } catch {
    return Math.ceil(text.length / 4)
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
