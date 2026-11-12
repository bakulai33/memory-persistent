import { describe, test, expect, afterEach } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkSourceTree, sourceHash } from "../src/selfcheck"

const FIXTURES = join(import.meta.dir, "fixtures", "source-tree")
const SRC = join(import.meta.dir, "..", "src")

const trees: string[] = []

/** Copies a fixture tree into a temp dir as real .ts files, so the check runs on disk. */
function materialize(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), "selfcheck-"))
  trees.push(root)
  const dir = join(root, "src")
  mkdirSync(dir, { recursive: true })
  for (const file of readdirSync(join(FIXTURES, fixture))) {
    if (!file.endsWith(".ts.txt")) continue
    copyFileSync(join(FIXTURES, fixture, file), join(dir, file.slice(0, -".txt".length)))
  }
  return dir
}

/** Writes the given files into a fresh temp src dir, in the order given. */
function tree(files: [string, string][]): string {
  const root = mkdtempSync(join(tmpdir(), "selfcheck-"))
  trees.push(root)
  const dir = join(root, "src")
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of files) writeFileSync(join(dir, name), content)
  return dir
}

afterEach(() => {
  for (const dir of trees.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("checkSourceTree", () => {
  test("returns no mismatch for a consistent tree", () => {
    expect(checkSourceTree(materialize("consistent"))).toEqual([])
  })

  test("reports an imported name that the target does not export", () => {
    const mismatches = checkSourceTree(materialize("mismatch"))

    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]!.from).toBe("./storage.js")
    expect(mismatches[0]!.importer.endsWith("index.ts")).toBe(true)
    expect(mismatches[0]!.missing).toEqual(["deleteMemoryFiles"])
  })

  test("the real plugin source tree is consistent", () => {
    expect(checkSourceTree(SRC)).toEqual([])
  })
})

describe("sourceHash", () => {
  test("is stable for identical content", () => {
    const files: [string, string][] = [
      ["index.ts", 'import { a } from "./a.js"\n'],
      ["a.ts", "export const a = 1\n"],
    ]
    expect(sourceHash(tree(files))).toBe(sourceHash(tree(files)))
  })

  test("changes when a file content changes", () => {
    const before = tree([["a.ts", "export const a = 1\n"]])
    const after = tree([["a.ts", "export const a = 2\n"]])
    expect(sourceHash(before)).not.toBe(sourceHash(after))
  })

  test("does not depend on the order files were written", () => {
    const first = tree([
      ["a.ts", "export const a = 1\n"],
      ["b.ts", "export const b = 2\n"],
    ])
    const second = tree([
      ["b.ts", "export const b = 2\n"],
      ["a.ts", "export const a = 1\n"],
    ])
    expect(sourceHash(first)).toBe(sourceHash(second))
  })
})
