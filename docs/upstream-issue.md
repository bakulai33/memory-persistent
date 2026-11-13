# Bug: local plugin loader caches a failed module link, poisoning the plugin for the process lifetime

## Summary

When a local plugin's module graph contains an import whose name the target module does
not export, the loader's link step throws:

```
SyntaxError: Export named '<name>' not found in module '<path>'
```

The failed evaluation is then cached, so every later reload of that plugin in the same
server process keeps failing the same way. The process keeps running the previous
generation of the plugin silently; the only trace is a single `WARN` line in the
server log. The plugin never recovers until the server is restarted.

This was observed with `@opencode/plugin` 2.2.5 (and 2.2.7) on Bun.

## Minimal reproduction

A ~40-line script that drives the loader the way OpenCode does, with a two-file
plugin in a temp directory. Run it with `bun`:

```js
import { mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createPluginSources } from "@opencode/plugin/source"

const fixture = "/path/to/two-file-plugin" // src/index.ts imports { greet } from "./dep.js"
const dir = mkdtempSync(join(tmpdir(), "lp-"))
cpSync(fixture, dir, { recursive: true })

const entry = pathToFileURL(join(dir, "src", "index.ts")).href
const sources = createPluginSources(async () => {})

// First load succeeds.
await sources.read(entry)

// Rename the export in dep.ts without updating the importer.
writeFileSync(join(dir, "src", "dep.ts"), 'export function greet2() {\n  return "hi"\n}\n')

let err
try {
  await sources.read(entry)
} catch (e) {
  err = e
}
console.log(String(err?.message ?? err))
// => Export named 'greet' not found in module '/tmp/.../src/dep.ts'.

// Even after restoring a consistent graph, the cached rejection persists for
// this process; a restart is required.
sources.dispose()
rmSync(dir, { recursive: true, force: true })
```

Fixture contents:

`src/index.ts`
```ts
import { greet } from "./dep.js"

export default { id: "lp", effect: () => greet() }
```

`src/dep.ts`
```ts
export function greet() {
  return "hi"
}
```

## Expected behaviour

After the export is renamed (and, in a real workflow, after the importer is updated
to match), a subsequent `read()` of the same entrypoint should load the corrected
module graph. At minimum, a mismatch should be reported in a way the developer can
act on, and the loader should not permanently poison that plugin for the life of the
process.

## Actual behaviour

The link step throws `SyntaxError: Export named 'greet' not found in module
'.../src/dep.ts'.` and the failed promise stays cached. Every later `read()` of the
same entrypoint keeps rejecting the same way until a content edit changes the file
digest. The server keeps running the previous generation of the plugin.

## Impact

Local plugins silently stop updating for the lifetime of a long-running server. The
only trace is one `WARN` line in the server log, so the regression is invisible
during normal use. Renaming an export across versions is enough to trigger it.

## Workaround

- Restart the server after changing a local plugin's source.
- Avoid renaming exports across versions; prefer additive changes.

## Evidence

This repository (`memory-persistent`) contains the reproduction as a regression
test in `test/loader.test.ts`, including the exact error message above. The test
deliberately does **not** assert that the brokenness is permanent, because that
behaviour is the defect being reported; it notes that a fix in the loader would
make a later successful reload (after a consistent edit) a meaningful expectation.
The companion self-check in `src/selfcheck.ts` exists specifically to catch this
mismatch before the loader ever sees it.