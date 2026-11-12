import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repairPermissions, writeMemory, emptyMemory } from "../src/storage"

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

  test("writeMemory produces 0600", async () => {
    await writeMemory("ses_perm", emptyMemory("ses_perm"))
    const path = join(dir, "opencode", "memory-persistent", "sessions", "ses_perm.json")
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})