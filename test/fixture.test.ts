import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { classifyToolCall, parseShellCommands } from "../src/metadata"

interface FixtureCall {
  tool: string
  input: Record<string, unknown>
  status?: string
  error?: unknown
}

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tool-calls.json"), "utf8"),
) as FixtureCall[]

describe("real session fixture", () => {
  test("the fixture holds real tool calls", () => {
    expect(fixture.length).toBeGreaterThan(50)
    expect(fixture.some((call) => call.tool === "shell")).toBe(true)
  })

  test("no parsed command is a path fragment or a script word", () => {
    for (const call of fixture) {
      if (call.tool !== "shell" && call.tool !== "bash") continue
      const command = call.input.command
      if (typeof command !== "string") continue
      for (const parsed of parseShellCommands(command)) {
        expect(parsed).not.toContain("/")
        expect(parsed).not.toContain(")")
        expect(parsed).not.toContain("=")
      }
    }
  })

  test("recorded activity stays small against the call count", () => {
    const activity = new Set<string>()
    for (const call of fixture) {
      for (const entry of classifyToolCall(call.tool, call.input, call)) {
        activity.add(`${entry.kind}:${entry.target}`)
      }
    }
    expect(activity.size).toBeLessThan(fixture.length / 3)
  })

  test("errors are always recorded", () => {
    for (const call of fixture) {
      if (call.status !== "error") continue
      const entries = classifyToolCall(call.tool, call.input, call)
      expect(entries.some((entry) => entry.kind === "error")).toBe(true)
    }
  })

  test("read-only tools contribute nothing", () => {
    for (const call of fixture) {
      if (call.tool !== "read") continue
      expect(classifyToolCall(call.tool, call.input, call)).toEqual([])
    }
  })

  test("no read-only command target is recorded", () => {
    const targets = new Set<string>()
    for (const call of fixture) {
      for (const entry of classifyToolCall(call.tool, call.input, call)) {
        if (entry.kind === "command") targets.add(entry.target)
      }
    }
    expect(targets.has("git status")).toBe(false)
    expect(targets.has("git log")).toBe(false)
    expect(targets.has("git diff")).toBe(false)
  })
})
