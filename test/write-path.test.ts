import { describe, test, expect, beforeAll } from "bun:test"
import { mock } from "bun:test"
import * as realFs from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const captured: string[] = []
const origWriteFile = realFs.writeFile
const origMkdir = realFs.mkdir
const origRename = realFs.rename
const origChmod = realFs.chmod
const origReadFile = realFs.readFile
const origReaddir = realFs.readdir
const origRm = realFs.rm

mock.module("node:fs/promises", () => ({
  writeFile: async (path: any, data: any, options: any) => {
    const p = String(path)
    if (p.includes(".tmp.")) captured.push(p)
    return origWriteFile(path, data, options)
  },
  mkdir: origMkdir,
  rename: origRename,
  chmod: origChmod,
  readFile: origReadFile,
  readdir: origReaddir,
  rm: origRm,
}))

const storage = await import("../src/storage")

describe("write path", () => {
  let dir: string
  let orig: string | undefined

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-"))
    orig = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = dir
  })

  test("temp path includes a unique component", async () => {
    captured.length = 0
    const sid = "ses_tmp_path"
    await storage.writeMemory(sid, storage.emptyMemory(sid))
    expect(captured.length).toBeGreaterThan(0)
    const tmp = captured[captured.length - 1]!
    // pid.timestamp.uuid — the trailing UUID is the unique component
    expect(tmp).toMatch(/\.tmp\.\d+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test("trailing cleanup", () => {
    if (orig === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = orig
    rmSync(dir, { recursive: true, force: true })
  })
})