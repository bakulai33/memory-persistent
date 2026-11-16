import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync, utimesSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repairPermissions, writeMemory, emptyMemory } from "../src/storage"
import { logEvent } from "../src/log"

describe("permissions", () => {
  let dir: string
  let orig: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  afterEach(() => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })

  test("repairPermissions fixes files and dirs", async () => {
    const root = join(dir, "opencode", "memory-persistent")
    const sessions = join(root, "sessions")
    mkdirSync(sessions, { recursive: true })
    chmodSync(root, 0o775)
    chmodSync(sessions, 0o775)
    const file = join(sessions, "old.json")
    writeFileSync(file, "{}")
    chmodSync(file, 0o644)
    const sub = join(sessions, "sub")
    mkdirSync(sub)
    chmodSync(sub, 0o775)
    const nested = join(sub, "nested.json")
    writeFileSync(nested, "{}")
    chmodSync(nested, 0o644)

    const res = await repairPermissions()
    expect(res.files).toBe(2)
    expect(res.dirs).toBe(3)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(nested).mode & 0o777).toBe(0o600)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(sessions).mode & 0o777).toBe(0o700)
    expect(statSync(sub).mode & 0o777).toBe(0o700)
  })

  test("repairPermissions tightens the log and the corrupt backups too", async () => {
    const root = join(dir, "opencode", "memory-persistent")
    const sessions = join(root, "sessions")
    mkdirSync(sessions, { recursive: true })

    const log = join(root, "plugin.log")
    writeFileSync(log, "line\n")
    chmodSync(log, 0o644)

    const build = join(root, "build.json")
    writeFileSync(build, "{}")
    chmodSync(build, 0o644)

    const backup = join(sessions, "ses_x.json.corrupt.1700000000000")
    writeFileSync(backup, "{")
    chmodSync(backup, 0o644)

    const res = await repairPermissions()
    expect(res.files).toBe(3)
    expect(statSync(log).mode & 0o777).toBe(0o600)
    expect(statSync(build).mode & 0o777).toBe(0o600)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
  })

  test("repairPermissions leaves an unrelated file alone", async () => {
    const root = join(dir, "opencode", "memory-persistent")
    mkdirSync(root, { recursive: true })
    const other = join(root, "notes.txt")
    writeFileSync(other, "text")
    chmodSync(other, 0o644)

    await repairPermissions()
    expect(statSync(other).mode & 0o777).toBe(0o644)
  })

  test("repairPermissions accepts a target directory", async () => {
    const target = join(dir, "custom")
    mkdirSync(target, { recursive: true })
    chmodSync(target, 0o775)
    const file = join(target, "a.json")
    writeFileSync(file, "{}")
    chmodSync(file, 0o644)

    const res = await repairPermissions(target)
    expect(res.files).toBe(1)
    expect(res.dirs).toBe(1)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(target).mode & 0o777).toBe(0o700)
  })

  test("repairPermissions tolerates a missing directory", async () => {
    const res = await repairPermissions(join(dir, "does-not-exist"))
    expect(res).toEqual({ files: 0, dirs: 0 })
  })

  test("repairPermissions removes an old tmp file but keeps a fresh one", async () => {
    const root = join(dir, "opencode", "memory-persistent")
    const sessions = join(root, "sessions")
    mkdirSync(sessions, { recursive: true })

    const session = join(sessions, "ses_live.json")
    writeFileSync(session, "{}")

    const stale = join(sessions, "ses_x.json.tmp.123.456.abc")
    writeFileSync(stale, "partial")
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000)
    utimesSync(stale, twoHoursAgo, twoHoursAgo)

    const fresh = join(sessions, "ses_y.json.tmp.999.888.ghi")
    writeFileSync(fresh, "partial")
    const oneMinuteAgo = new Date(Date.now() - 60_000)
    utimesSync(fresh, oneMinuteAgo, oneMinuteAgo)

    const res = await repairPermissions()
    // Tmp files are not private files, so the counts stay stable.
    expect(res.files).toBe(1)
    expect(existsSync(session)).toBe(true)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test("writeMemory produces 0600", async () => {
    await writeMemory("ses_perm", emptyMemory("ses_perm"))
    const path = join(dir, "opencode", "memory-persistent", "sessions", "ses_perm.json")
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("the plugin log is created with 0600", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logEvent("capture", { sid: "ses_perm", tier: "always", turns: 1 })
    } finally {
      errors.mockRestore()
    }
    const path = join(dir, "opencode", "memory-persistent", "plugin.log")
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("an existing plugin log is tightened to 0600", () => {
    const root = join(dir, "opencode", "memory-persistent")
    mkdirSync(root, { recursive: true })
    const path = join(root, "plugin.log")
    writeFileSync(path, "old line\n")
    chmodSync(path, 0o644)

    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      logEvent("capture", { sid: "ses_perm", tier: "always", turns: 1 })
    } finally {
      errors.mockRestore()
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})