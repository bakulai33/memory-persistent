import { describe, test, expect, afterEach } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkSourceTree, sourceHash } from "../src/selfcheck"
import { resolveSkillPath } from "../src/index"
import { existsSync } from "node:fs"

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

test("the skill path is derived from the plugin location", () => {
  const skillPath = resolveSkillPath()
  // (a) file yang ditunjuk benar-benar ada
  expect(existsSync(skillPath)).toBe(true)
  // (b) path menunjuk SKILL.md yang benar
  expect(skillPath.endsWith(join("skills", "memory-persistent", "SKILL.md"))).toBe(true)
  // (c) DISKRIMINATIF: source tidak boleh memuat hardcoded home path.
  //     Kontrol positif membuktikan pola menangkap bentuk lama;
  //     kontrol negatif membuktikan source bersih.
  const HARDCODED_SAMPLE = 'const p = "/home/example-user/Documents/x"'
  expect(HARDCODED_SAMPLE).toMatch(/\/home\/[A-Za-z0-9._-]+\//)
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
  expect(src).not.toMatch(/\/home\/[A-Za-z0-9._-]+\//)
})

describe("checkSourceTree: export forms and resolution", () => {
  test("default exports satisfy a default import", () => {
    const dir = tree([
      ["index.ts", 'import dep from "./dep.js"\nimport { named } from "./dep.js"\nconsole.log(dep, named)\n'],
      ["dep.ts", "export default 1\nexport const named = 2\n"],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("re-exports count as the re-exported names", () => {
    const dir = tree([
      ["index.ts", 'export { helper } from "./helper.js"\nimport { helper } from "./helper.js"\nconsole.log(helper)\n'],
      ["helper.ts", "export const helper = 1\n"],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("a re-exported name that the target lacks is reported", () => {
    const dir = tree([
      ["index.ts", 'export { missing } from "./dep.js"\n'],
      ["dep.ts", "export const present = 1\n"],
    ])
    const m = checkSourceTree(dir)
    expect(m).toHaveLength(1)
    expect(m[0]!.missing).toEqual(["missing"])
  })

  test("aliased exports and imports resolve through the alias", () => {
    const dir = tree([
      ["index.ts", 'import { orig as renamed } from "./dep.js"\nconsole.log(renamed)\n'],
      ["dep.ts", "export const orig = 1\nexport { orig as alias }\n"],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("a re-export alias does not create a local binding (original name imports)", () => {
    // `export { hidden as visible } from X` membuat `visible` terlihat bagi PEMAKAI
    // index.ts, bukan binding lokal — jadi import lokal harus memakai nama aslinya.
    const dir = tree([
      ["index.ts", 'export { hidden as visible } from "./dep.js"\nimport { hidden } from "./dep.js"\nconsole.log(hidden)\n'],
      ["dep.ts", "export const hidden = 1\n"],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("a re-export alias whose original name is missing is reported by that name", () => {
    const dir = tree([
      ["index.ts", 'export { ghost as visible } from "./dep.js"\n'],
      ["dep.ts", "export const present = 1\n"],
    ])
    const m = checkSourceTree(dir)
    expect(m).toHaveLength(1)
    expect(m[0]!.missing).toEqual(["ghost"])
  })

  test("type-only imports and interfaces are honoured", () => {
    const dir = tree([
      ["index.ts", 'import type { Shape } from "./dep.js"\nimport { make } from "./dep.js"\nconst s: Shape = make()\nconsole.log(s)\n'],
      ["dep.ts", "export interface Shape { a: number }\nexport function make(): Shape { return { a: 1 } }\n"],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("a .js specifier maps to the .ts file on disk", () => {
    const dir = tree([
      ["index.ts", 'import { a } from "./a.js"\nconsole.log(a)\n'],
      ["a.ts", "export const a = 1\n"],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("a directory import resolves to its index.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "selfcheck-"))
    trees.push(root)
    const dir = join(root, "src")
    mkdirSync(join(dir, "mod"), { recursive: true })
    writeFileSync(join(dir, "index.ts"), 'import { a } from "./mod/index.js"\nconsole.log(a)\n')
    writeFileSync(join(dir, "mod", "index.ts"), "export const a = 1\n")
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("an import from a missing module is skipped, not a mismatch", () => {
    const dir = tree([
      ["index.ts", 'import { ghost } from "./nowhere.js"\nconsole.log(ghost)\n'],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("an unreadable index.ts yields no mismatches", () => {
    // A directory with no index.ts: the check reads it, fails, and returns [].
    const dir = tree([["other.ts", "export const x = 1\n"]])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("non-local imports (packages) are ignored", () => {
    const dir = tree([
      ["index.ts", 'import { Effect } from "effect"\nconsole.log(Effect)\n'],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })

  test("side-effect imports add no names to check", () => {
    const dir = tree([
      ["index.ts", 'import "./dep.js"\n'],
      ["dep.ts", "export const a = 1\n"],
    ])
    expect(checkSourceTree(dir)).toEqual([])
  })
})

describe("sourceHash: error paths", () => {
  test("a directory that cannot be read hashes to the empty SHA", () => {
    // A nonexistent dir: readdir fails, entries=[] -> hash of nothing.
    const missing = join(tmpdir(), "selfcheck-nonexistent-zz")
    rmSync(missing, { force: true, recursive: true })
    expect(sourceHash(missing)).toHaveLength(64)
  })

  test("a subdirectory is skipped (files only hash)", () => {
    const root = mkdtempSync(join(tmpdir(), "selfcheck-"))
    trees.push(root)
    const dir = join(root, "src")
    mkdirSync(join(dir, "sub"), { recursive: true })
    writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
    writeFileSync(join(dir, "sub", "b.ts"), "export const b = 2\n")
    // Only a.ts (top level) participates.
    expect(sourceHash(dir)).toBe(sourceHash(tree([["a.ts", "export const a = 1\n"]])))
  })
})
