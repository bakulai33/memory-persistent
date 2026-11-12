import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createPluginSources } from "@opencode/plugin/source"

const FIXTURE = join(import.meta.dir, "fixtures", "loader-plugin")

describe("OpenCode plugin loader (regression)", () => {
  let dir: string
  let sources: ReturnType<typeof createPluginSources> | undefined

  afterEach(() => {
    sources?.dispose()
    sources = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function freshCopy(): string {
    dir = mkdtempSync(join(tmpdir(), "lp-"))
    cpSync(FIXTURE, dir, { recursive: true })
    return dir
  }

  test("memuat plugin lewat loader asli", async () => {
    const d = freshCopy()
    const entry = pathToFileURL(join(d, "src", "index.ts")).href
    sources = createPluginSources(async () => {})
    const loaded = await sources.read(entry)
    const mod = loaded.module as { default?: { id: unknown; effect: unknown } }
    expect(mod.default).toBeDefined()
    expect(typeof mod.default!.effect).toBe("function")
  })

  test("hot-reload berhasil setelah edit konsisten", async () => {
    const d = freshCopy()
    const entry = pathToFileURL(join(d, "src", "index.ts")).href
    sources = createPluginSources(async () => {})
    const first = await sources.read(entry)
    // content-only edit: comment added, exports unchanged
    writeFileSync(join(d, "src", "dep.ts"), 'export function greet() {\n  return "hi"\n}\n// edited\n')
    const second = await sources.read(entry)
    expect(second.version).not.toBe(first.version)
  })

  test("rename export tanpa importer ditolak loader", async () => {
    const d = freshCopy()
    const entry = pathToFileURL(join(d, "src", "index.ts")).href
    sources = createPluginSources(async () => {})
    await sources.read(entry)
    // rename export in dep.ts without updating importer
    writeFileSync(join(d, "src", "dep.ts"), 'export function greet2() {\n  return "hi"\n}\n')
    let err: unknown
    try {
      await sources.read(entry)
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect(String((err as Error)?.message ?? err)).toContain("Export named '")

    // NOTE: observed on @opencode/plugin 2.2.5 (and 2.2.7): after the link step
    // throws, the failed promise stays cached in the loader and every later
    // read() of the same entrypoint keeps rejecting the same way until a
    // content edit changes the file digest. The loader may be fixed in a future
    // version; we deliberately do NOT assert that permanent brokenness here,
    // because that would turn into a false alarm. This is the reason the source
    // self-check (src/selfcheck.ts) exists: catch the mismatch before the loader
    // ever sees it.
  })
})