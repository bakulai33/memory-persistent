/**
 * Regenerates the committed tool-call fixture.
 *
 * The fixture is shaped like a real session: the same tools, the same shell
 * idioms, the same mix of read-only and meaningful calls. Every path, host and
 * command in it is invented. Nothing is copied from a real session, because a
 * real session carries credentials and absolute paths that must never reach
 * the repository (design spec section 9b).
 *
 * The two parser edge cases the fixture has to keep are:
 *   1. a pipe character inside a quoted pattern (`grep -R "a\|b"`), and
 *   2. a command substitution that contains a closing parenthesis
 *      (`$(python3 -c "...json.load(sys.stdin)['data']['id'])"`).
 *
 * Run: bun run test/fixtures/generate-tool-calls.ts
 */
import { writeFileSync } from "node:fs"

export interface FixtureCall {
  tool: string
  input: Record<string, unknown>
  status?: string
  error?: unknown
}

/** The synthetic workspace every path in the fixture lives under. */
const ROOT = "/workspace/app"

const calls: FixtureCall[] = []

function shell(command: string, status = "completed", error?: unknown): void {
  const call: FixtureCall = { tool: "shell", input: { command }, status }
  if (error !== undefined) call.error = error
  calls.push(call)
}

function file(tool: string, path: string, extra: Record<string, unknown> = {}): void {
  calls.push({ tool, input: { path, ...extra }, status: "completed" })
}

function other(tool: string, input: Record<string, unknown>, status = "completed", error?: unknown): void {
  const call: FixtureCall = { tool, input, status }
  if (error !== undefined) call.error = error
  calls.push(call)
}

// ---------------------------------------------------------------------------
// Read-only tools: they contribute nothing to the recorded activity.
// ---------------------------------------------------------------------------
file("read", `${ROOT}/package.json`)
file("read", `${ROOT}/README.md`)
file("read", `${ROOT}/src/index.ts`)
file("read", `${ROOT}/src/metadata.ts`)
file("read", `${ROOT}/src/storage.ts`)
file("read", `${ROOT}/test/metadata.test.ts`)
other("glob", { pattern: `${ROOT}/src/**/*.ts` })
other("glob", { pattern: `${ROOT}/test/**/*.ts` })
other("glob", { pattern: `${ROOT}/docs/**/*.md` })
other("grep", { pattern: "classifyToolCall", path: ROOT })
other("grep", { pattern: "withLock", path: ROOT })
other("webfetch", { url: "https://example.invalid/docs", format: "markdown" })
other("webfetch", { url: "https://example.invalid/guides", format: "text" })
other("skill", { id: "planning" })
other("skill", { id: "reviewing" })
other("execute", { code: "const out = await tools.read({ path: 'src/index.ts' }); return out" })
other("execute", { code: "const out = await tools.grep({ pattern: 'redact' }); return out" })
other("execute", { code: "const out = await tools.list({ path: 'src' }); return out" })
other("execute", { code: "const out = await tools.glob({ pattern: 'test/**' }); return out" })

// ---------------------------------------------------------------------------
// File tools: a few distinct paths, repeated, so the recorded activity stays
// small relative to the number of calls.
// ---------------------------------------------------------------------------
file("write", `${ROOT}/src/index.ts`, { content: "// plugin entry point\n" })
file("write", `${ROOT}/src/metadata.ts`, { content: "// tool call classification\n" })
file("write", `${ROOT}/src/storage.ts`, { content: "// per-session storage\n" })
file("write", `${ROOT}/test/metadata.test.ts`, { content: "// classifier tests\n" })
file("write", `${ROOT}/README.md`, { content: "# workspace app\n" })
file("write", `${ROOT}/package.json`, { content: '{ "name": "workspace-app" }\n' })
file("write", `${ROOT}/src/index.ts`, { content: "// plugin entry point\n" })
calls.push({ tool: "edit", input: { filePath: `${ROOT}/src/index.ts`, oldText: "a", newText: "b" }, status: "completed" })
calls.push({ tool: "edit", input: { filePath: `${ROOT}/src/metadata.ts`, oldText: "a", newText: "b" }, status: "completed" })
calls.push({ tool: "edit", input: { filePath: `${ROOT}/src/storage.ts`, oldText: "a", newText: "b" }, status: "completed" })
calls.push({ tool: "patch", input: { path: `${ROOT}/src/index.ts`, patch: "@@ -1 +1 @@" }, status: "completed" })
calls.push({ tool: "write", input: { path: `${ROOT}/src/storage.ts`, content: "// per-session storage\n" }, status: "completed" })
calls.push({ tool: "write", input: { path: `${ROOT}/test/metadata.test.ts`, content: "// classifier tests\n" }, status: "completed" })

// ---------------------------------------------------------------------------
// Read-only shell commands: no activity is recorded for them, so this list can
// be as varied as a real session is.
// ---------------------------------------------------------------------------
shell("ls -la /workspace/app")
shell("ls -la /workspace/app/src")
shell("ls -1 /workspace/app/test")
shell("cat /workspace/app/package.json")
shell("cat /workspace/app/README.md")
shell("head -40 /workspace/app/src/index.ts")
shell("head -1 /workspace/app/src/*.ts")
shell("tail -20 /workspace/app/build.log")
shell("wc -l /workspace/app/src/index.ts")
shell("find /workspace/app -maxdepth 2 -type f -name '*.ts'")
shell("find /workspace/app -maxdepth 3 -type d")
shell("find . -name '*.ts' -not -path './node_modules/*' | head -20")
shell("grep -rn 'export function' /workspace/app/src")
shell("grep -rn 'TODO' /workspace/app/src")
shell("grep -rn 'redact' src | head -20")
shell("grep -R 'alpha\\|beta' /workspace/app/src | grep -n 'beta'")
shell("sed -n '1,60p' /workspace/app/src/index.ts")
shell("awk '{ print $1 }' /workspace/app/src/index.ts")
shell("sort /workspace/app/out/names.txt")
shell("uniq /workspace/app/out/names.txt")
shell("diff /workspace/app/out/a.txt /workspace/app/out/b.txt")
shell("stat /workspace/app/src/index.ts")
shell("du -sh /workspace/app/out")
shell("tree -L 2 /workspace/app")
shell("pwd")
shell("which bun")
shell("env | sort")
shell("git status")
shell("git status --short")
shell("git log --oneline -10")
shell("git diff")
shell("git diff --stat")
shell("git show HEAD")
shell("git branch -a")
shell("git remote -v")
shell("git blame src/index.ts")
shell("git describe --tags")
shell("git -C /workspace/app status")
shell("git --no-pager log")
shell("git log --graph --oneline -20")
shell("git show --stat HEAD")
shell("git diff --name-only")
shell("git ls-files")
shell("git grep -n 'pendingActivity'")
shell("grep -c '' /workspace/app/src/index.ts")
shell("head -c 200 /workspace/app/README.md")
shell("tail -c 200 /workspace/app/README.md")
shell("cut -d, -f1 /workspace/app/out/rows.csv")
shell("tr '[:upper:]' '[:lower:]' /workspace/app/out/names.txt")
shell("nl -ba /workspace/app/src/index.ts | head -40")
shell("less -F /workspace/app/build.log")
shell("file /workspace/app/out/app.tar")
shell("readlink /workspace/app/current")
shell("basename /workspace/app/out/app.tar")
shell("dirname /workspace/app/out/app.tar")
shell("realpath /workspace/app/out/app.tar")
shell("printf '%s\\n' alpha beta")
shell("date -u")
shell("uname -r")
shell("whoami")
shell("id -u")
shell("ps -ef | head -20")
shell("lsof -i :8080")
shell("netstat -an | head -20")
shell("df -h /workspace/app")
shell("free -m")
shell("uptime")
shell("which python3")
shell("type -a bun")
shell("history | tail -5")

// ---------------------------------------------------------------------------
// The two parser edge cases the fixture must keep.
// ---------------------------------------------------------------------------
// 1. A pipe inside a quoted pattern is not a command separator.
shell('grep -R "alpha\\|beta" /workspace/app/src')
shell('grep -n "export \\* as\\|export const" /workspace/app/src/index.ts')
// 2. A command substitution that contains a closing parenthesis.
shell('ID=$(python3 -c "import json,sys; print(json.load(sys.stdin)[\'data\'][\'id\'])") && bun run build')
shell('OUT=$(printf \'a)b\') && bun test')
shell('python3 -c "import json; print(json.loads(\'{}\'))"')

// ---------------------------------------------------------------------------
// Meaningful shell commands: these are the ones that become activity.
// ---------------------------------------------------------------------------
shell("bun test")
shell("bun test")
shell("bun test")
shell("bun test --coverage")
shell("bun run build")
shell("bun run build")
shell("bun run lint")
shell("bun install")
shell("bun install --frozen-lockfile")
shell("git add .")
shell("git add src")
shell('git commit -m "update the classifier"')
shell('git commit -m "fix the lock map"')
shell("git push origin main")
shell("git rebase main")
shell("npm run lint")
shell("npm run build")
shell("npm install")
shell("npm run lint && npm run build")
shell("tsc --noEmit")
shell("tsc")
shell("pytest -q")
shell("python3 -m pytest tests")
shell("make build")
shell("docker build -t workspace-app:latest .")
shell("docker compose up -d")
shell("terraform apply -auto-approve")
shell("rm -rf build")
shell("mkdir -p out")
shell("node scripts/build.mjs")
shell("python3 - <<'PYEOF'\nimport json\nprint(json.dumps({'ok': True}))\nPYEOF")
shell("cat > out/notes.txt <<'EOF'\nline one\nline two\nEOF")
shell("cd /workspace/app && bun test")
shell("cd /workspace/app && git status")
shell("cd /workspace/app && npm run build")
shell("X=1 bun test")
shell("X=$(cat out/env) bun run build")
shell("bun test 2>&1 | tail -3")
shell("bun test 2>&1 | grep -n 'fail'")
shell("git add src && bun test && git commit -m \"all green\"")
shell("bun run lint; bun run build")
shell("bun test\nbun run build")
shell("git commit -am 'wip'")
shell("git checkout -b feature/parser")
shell("git merge main")
shell("git stash")
shell("git tag v0.4.0")

// ---------------------------------------------------------------------------
// Failures: an error is always recorded, whatever the tool was.
// ---------------------------------------------------------------------------
shell("bun test", "error", "exit code 1: 3 tests failed")
shell("bun test", "error", "exit code 1: 3 tests failed")
shell("npm run build", "error", { message: "TypeError: cannot read properties of undefined (reading 'id')" })
shell("tsc --noEmit", "error", "error TS2345: argument of type 'string' is not assignable")
shell("git push origin main", "error", "remote rejected the push (non-fast-forward)")
shell("docker compose up -d", "error", { message: "service 'app' failed to start" })
other("glob", { pattern: `${ROOT}/nope/**` }, "error", "glob timed out after 30s")
other("grep", { pattern: "missing", path: ROOT }, "error", "ENOENT: no such file or directory")
other("webfetch", { url: "https://example.invalid/missing" }, "error", "request timed out")
other("execute", { code: "throw new Error('codemode failed')" }, "error", { message: "codemode failed" })

const target = new URL("./tool-calls.json", import.meta.url)
writeFileSync(target, `${JSON.stringify(calls, null, 2)}\n`, "utf8")
console.error(`wrote ${calls.length} calls to ${target.pathname}`)
