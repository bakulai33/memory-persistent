import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logEvent, logPath } from "../src/log"

describe("logEvent", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-log-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("writes a redacted 0600 line next to the sessions dir", () => {
    logEvent("retry", { secret: "AKIAIOSFODNN7EXAMPLE", ok: 1 })

    const path = logPath()
    expect(path.endsWith(join("memory-persistent", "plugin.log"))).toBe(true)
    const content = readFileSync(path, "utf8")
    expect(content).toContain("retry")
    expect(content).toContain("[REDACTED]")
    expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE")

    const stat = statSync(path)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test("appends and keeps the log bounded at 64 KiB", () => {
    for (let i = 0; i < 900; i++) logEvent("filler", { index: i, note: "x".repeat(80) })
    const stat = statSync(logPath())
    expect(stat.size).toBeLessThanOrEqual(64 * 1024 + 2)
    const content = readFileSync(logPath(), "utf8")
    expect(content.split("\n").length).toBeGreaterThan(1)
  })
})
