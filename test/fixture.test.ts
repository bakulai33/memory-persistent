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

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tool-calls.json")
const fixtureText = readFileSync(fixturePath, "utf8")
const fixture = JSON.parse(fixtureText) as FixtureCall[]

/**
 * The fixture is committed to the repository, so it may only hold invented
 * text. A real session carries absolute paths, hostnames and credentials, and
 * none of those may ever reach the git history (design spec section 9b).
 */
const FORBIDDEN_IN_FIXTURE: { pattern: RegExp; what: string }[] = [
  { pattern: /\/home\/[A-Za-z0-9_.-]+/g, what: "a real home directory" },
  { pattern: /\/Users\//g, what: "a macOS home directory" },
  { pattern: /\/root\//g, what: "a root home directory" },
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, what: "an IPv4 address" },
  { pattern: /\b(?:password|passwd|secret|api[_-]?key|token|auth|bearer|credential)\b\s*[:=]/gi, what: "a credential" },
  { pattern: /sk-[A-Za-z0-9]{20,}/g, what: "an API key" },
  { pattern: /ghp_[A-Za-z0-9]{30,}/g, what: "a GitHub token" },
  { pattern: /authorization\s*:/gi, what: "an authorization header" },
  { pattern: /ses_[A-Za-z0-9]{16,}/g, what: "a real session id" },
]

describe("synthetic session fixture", () => {
  test("the fixture holds real-shaped tool calls", () => {
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
    let failures = 0
    for (const call of fixture) {
      if (call.status !== "error") continue
      failures += 1
      const entries = classifyToolCall(call.tool, call.input, call)
      expect(entries.some((entry) => entry.kind === "error")).toBe(true)
    }
    // The rule is only meaningful when the fixture actually holds failures.
    expect(failures).toBeGreaterThan(0)
  })

  test("read-only tools contribute nothing", () => {
    let reads = 0
    for (const call of fixture) {
      if (call.tool !== "read") continue
      reads += 1
      expect(classifyToolCall(call.tool, call.input, call)).toEqual([])
    }
    expect(reads).toBeGreaterThan(0)
  })

  test("a failed tool that is otherwise ignored records only the error", () => {
    const failed = fixture.filter(
      (call) => call.status === "error" && call.tool !== "shell" && call.tool !== "read",
    )
    expect(failed.length).toBeGreaterThan(0)
    for (const call of failed) {
      const entries = classifyToolCall(call.tool, call.input, call)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.kind).toBe("error")
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

  test("the fixture keeps the two parser edge cases", () => {
    const commands = fixture
      .filter((call) => call.tool === "shell" || call.tool === "bash")
      .map((call) => call.input.command)
      .filter((command): command is string => typeof command === "string")

    // A pipe inside a quoted pattern is not a command separator.
    expect(commands.some((command) => command.includes("\\|"))).toBe(true)
    // A command substitution may contain a closing parenthesis.
    expect(commands.some((command) => command.includes("$(python3 -c"))).toBe(true)
    expect(commands.some((command) => command.includes("json.load(sys.stdin)"))).toBe(true)
  })

  test("the fixture holds no real path, host or credential", () => {
    for (const { pattern, what } of FORBIDDEN_IN_FIXTURE) {
      const found = fixtureText.match(new RegExp(pattern.source, pattern.flags))
      expect(found === null ? null : `${what}: ${found[0]}`).toBeNull()
    }
  })
})
