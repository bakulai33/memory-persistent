import { describe, test, expect } from "bun:test"
import { parseShellCommands, classifyToolCall, SHELL_ALLOW, normalizeActivityTarget } from "../src/metadata"
import { emptyMemory, addActivity } from "../src/storage"
import { redact } from "../src/redact"

describe("parseShellCommands", () => {
  test("reads the command name of a chained invocation", () => {
    expect(parseShellCommands("cd /x && ls -la && git log --oneline -5")).toEqual(["cd", "ls", "git"])
  })

  test("drops trivial commands but keeps the meaningful one", () => {
    expect(parseShellCommands("bun test 2>&1 | tail -3")).toEqual(["bun", "tail"])
  })

  test("removes command substitutions before splitting", () => {
    expect(parseShellCommands("AUTH=$(cat /tmp/x) && curl -s http://y")).toEqual(["curl"])
  })

  test("removes backtick substitutions", () => {
    expect(parseShellCommands("echo `date` && git status")).toEqual(["echo", "git"])
  })

  test("removes brace expansions", () => {
    expect(parseShellCommands("ls ${DIR}/x && bun run")).toEqual(["ls", "bun"])
  })

  test("skips environment assignments", () => {
    expect(parseShellCommands("BASE=http://x SID=$(cat f) && mkdir -p d")).toEqual(["mkdir"])
  })

  test("keeps a command that follows an assignment with a spaced value", () => {
    expect(parseShellCommands("X=$(cat file) make")).toEqual(["make"])
  })

  test("treats a heredoc body as a script, not as commands", () => {
    const command = "cd /x && python3 - <<'PYEOF'\nre = re.compile(r'\\bgo\\b')\nPYEOF"
    expect(parseShellCommands(command)).toEqual(["cd", "python3"])
  })

  test("does not leak words from a heredoc body", () => {
    const command = "python3 - <<'PYEOF'\nfor x in bash edit write patch:\n  pass\nPYEOF"
    const parsed = parseShellCommands(command)
    for (const leaked of ["bash", "edit", "write", "patch"]) expect(parsed).not.toContain(leaked)
  })

  test("does not leak path fragments from substitutions", () => {
    for (const parsed of parseShellCommands("X=$(cat /tmp/a/b) && git log")) {
      expect(parsed).not.toContain("/")
      expect(parsed).not.toContain(")")
    }
  })

  test("splits on newlines and semicolons", () => {
    expect(parseShellCommands("git status; bun test\nnpm run build")).toEqual(["git", "bun", "npm"])
  })
})

describe("classifyToolCall", () => {
  test("records a file tool as file activity", () => {
    const entries = classifyToolCall("write", { path: "/repo/src/index.ts" }, { status: "completed" })
    expect(entries).toEqual([{ kind: "file", target: "/repo/src/index.ts", command: null, turnID: undefined }])
  })

  test("records a meaningful shell command", () => {
    const entries = classifyToolCall("shell", { command: "cd /x && bun test" }, { status: "completed" })
    expect(entries).toEqual([{ kind: "command", target: "bun test", command: "bun", turnID: undefined }])
  })

  test("redacts a secret in a command target (T2.2)", () => {
    const entries = classifyToolCall("shell", { command: 'curl "https://api.test/v1?api_key=SUPERSECRET123"' }, { status: "completed" })
    expect(entries[0]!.kind).toBe("command")
    expect(JSON.stringify(entries)).not.toContain("SUPERSECRET123")
    expect(JSON.stringify(entries)).toContain("[REDACTED]")
  })

  test("keeps file targets unredacted (T2.2)", () => {
    const entries = classifyToolCall("write", { path: "src/token.ts" }, { status: "completed" })
    expect(entries[0]!.target).toBe("src/token.ts")
  })

  test("ignores trivial shell commands", () => {
    expect(classifyToolCall("shell", { command: "cd /x && ls -la" }, { status: "completed" })).toEqual([])
  })

  test("ignores read-only tools", () => {
    expect(classifyToolCall("read", { path: "/repo/file.ts" }, { status: "completed" })).toEqual([])
  })

  test("ignores the codemode execute tool", () => {
    expect(classifyToolCall("execute", { code: "tools.read({})" }, { status: "completed" })).toEqual([])
  })

  test("always records an error, even for an ignored tool", () => {
    const entries = classifyToolCall("read", { path: "/x" }, { status: "error", error: { message: "not found" } })
    expect(entries).toEqual([{ kind: "error", target: "not found", command: null, turnID: undefined }])
  })

  test("redacts a credential in a tool error", () => {
    const entries = classifyToolCall(
      "shell",
      { command: "bun test" },
      { status: "error", error: "provider rejected the call: api_key=sk-abcdefghijklmnopqrstuvwxyz" },
    )
    const error = entries.find((entry) => entry.kind === "error")
    expect(error?.target).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(error?.target).toContain("[REDACTED]")
  })

  test("redacts a bearer token in a tool error", () => {
    const entries = classifyToolCall(
      "read",
      { path: "/x" },
      { status: "error", error: { message: "request failed with Bearer abcdefghijklmnopqrstuvwxyz" } },
    )
    const error = entries.find((entry) => entry.kind === "error")
    expect(error?.target).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(error?.target).toContain("[REDACTED]")
  })

  test("redacts a credential that sits at the start of a long error", () => {
    const entries = classifyToolCall(
      "read",
      { path: "/x" },
      { status: "error", error: `api_key=sk-abcdefghijklmnopqrstuvwxyz ${"x".repeat(300)}` },
    )
    const error = entries.find((entry) => entry.kind === "error")
    expect(error?.target).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
    expect(error?.target).toContain("[REDACTED]")
  })

  test("keeps the error target inside its length cap", () => {
    const entries = classifyToolCall("read", { path: "/x" }, { status: "error", error: "y".repeat(1_000) })
    const error = entries.find((entry) => entry.kind === "error")
    expect(error?.target.length).toBe(200)
  })

  test("records both the command and the error of a failed call", () => {
    const entries = classifyToolCall("shell", { command: "bun test" }, { status: "error", error: "boom" })
    expect(entries.map((e) => e.kind)).toEqual(["command", "error"])
  })

  test("carries the turn id onto every entry", () => {
    const entries = classifyToolCall("write", { path: "/x.ts" }, { status: "completed" }, "msg_1")
    expect(entries[0]?.turnID).toBe("msg_1")
  })

  test("records the subcommand for a shell command", () => {
    expect(classifyToolCall("shell", { command: "git commit -m x" }, { status: "completed" })).toEqual([
      { kind: "command", target: "git commit", command: "git", turnID: undefined },
    ])
    expect(classifyToolCall("shell", { command: "bun test" }, { status: "completed" })).toEqual([
      { kind: "command", target: "bun test", command: "bun", turnID: undefined },
    ])
  })

  test("drops read-only git subcommands", () => {
    expect(classifyToolCall("shell", { command: "git status" }, { status: "completed" })).toEqual([])
  })

  test("skips git global flags before the subcommand", () => {
    expect(classifyToolCall("shell", { command: "git -c user.name=x commit" }, { status: "completed" })).toEqual([
      { kind: "command", target: "git commit", command: "git", turnID: undefined },
    ])
    expect(classifyToolCall("shell", { command: "git -C /tmp status" }, { status: "completed" })).toEqual([])
    expect(classifyToolCall("shell", { command: "git commit -m \"msg\"" }, { status: "completed" })).toEqual([
      { kind: "command", target: "git commit", command: "git", turnID: undefined },
    ])
    expect(classifyToolCall("shell", { command: "git --no-pager log" }, { status: "completed" })).toEqual([])
  })

  test("the allow-list holds no trivial commands", () => {
    for (const trivial of ["cd", "ls", "cat", "grep", "find", "echo", "pwd", "which", "head", "tail", "sed", "awk"]) {
      expect(SHELL_ALLOW.has(trivial)).toBe(false)
    }
  })

  test("errorMultiBarisJadiSatuBaris", () => {
    const entries = classifyToolCall("bash", { command: "bun x" }, {
      status: "error",
      error: "Could not find oldString in /a.ts.\n\nThe closest lines in the file:\n249:  foo",
    })
    const err = entries.find((e) => e.kind === "error")!
    expect(err.target).not.toContain("\n")
    expect(err.target).toContain("The closest lines in the file: 249: foo")
  })

  test("fileTargetDenganOldStringDipangkasKePath", () => {
    const entries = classifyToolCall("edit", {
      path: '/proj/src/metadata.ts\noldString="""const A = 1"""\nnewString="""const A = 2"""',
      oldString: "x", newString: "y",
    }, {})
    const file = entries.find((e) => e.kind === "file")!
    expect(file.target).toBe("/proj/src/metadata.ts")
    expect(file.target).not.toContain("oldString")
    expect(file.target).not.toContain("\n")
  })

  test("fileTargetTidakDiRedact", () => {
    // `redact()` mengubah "token = ..." menjadi "[REDACTED]" — justru input seperti
    // inilah yang membuktikan redact() TIDAK dijalankan pada target file.
    const entries = classifyToolCall("edit", { path: "token = tokens[cursor]!" }, {})
    expect(entries.find((e) => e.kind === "file")!.target).toBe("token = tokens[cursor]!")
  })

  test("targetMultiBarisTidakMasukKeFacts", async () => {
    const m = emptyMemory("ses_nl")
    const entries = classifyToolCall("bash", { command: "bun x" }, {
      status: "error", error: "line1\nline2\nline3",
    })
    for (const e of entries) addActivity(m, e as any)
    const facts = m.pendingActivity.map((a) => `- ${a.kind}: ${a.target}`).join("\n")
    expect(facts.split("\n").every((l) => l.startsWith("- "))).toBe(true)
  })
})

describe("redact patterns", () => {
  // [nama, input, rahasia yang HARUS hilang]
  const secrets: Array<[string, string, string]> = [
    ["Basic auth header", "Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["Proxy-Authorization header", "Proxy-Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["AWS access key id", "upload failed for AKIAIOSFODNN7EXAMPLE bucket", "AKIAIOSFODNN7EXAMPLE"],
    [
      "JWT",
      "invalid jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
    ],
    ["postgres URL credentials", "connect postgres://user:pass@db.local/app", "user:pass"],
    ["https URL credentials", "clone https://user:pass@github.com/org/repo", "user:pass"],
    ["fine-grained GitHub token", "auth github_pat_11AAAAAAA0abcdefghijKLMNOPqrstuvwxYZ123456", "github_pat_11AAAAAAA0abcdefghijKLMNOPqrstuvwxYZ123456"],
    [
      "multiline private key block",
      "verify -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY----- done",
      "MIIEowIBAAKCAQEA",
    ],
    // T2.2: JSON quoted keys (pattern lama tak mencocokkan `"` sebelum `:`)
    ["JSON quoted api_key", '{"api_key": "SUPERSECRET123"}', "SUPERSECRET123"],
    ["JSON quoted password", '{"password": "hunter2secret"}', "hunter2secret"],
    // T2.2: bare provider tokens
    ["npm token", "export NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz012345678", "npm_abcdefghijklmnopqrstuvwxyz012345678"],
    ["anthropic token", "Authorization: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890"],
    ["openai project token", "key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890", "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"],
    ["google api key", "googlemaps key=AIzaSyA1234567890abcdefghijklmnopqrstuv", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
    ["slack bot token", "webhook token xoxb-123456789012-1234567890123-abcdefghijklmnopqr", "xoxb-123456789012-1234567890123-abcdefghijklmnopqr"],
    ["gitlab pat", "clone glpat-abcdefghijklmnopqrst", "glpat-abcdefghijklmnopqrst"],
    ["aws temporary key", "upload with ASIAXXXXXXXXXXXXXXXX session key", "ASIAXXXXXXXXXXXXXXXX"],
  ]

  for (const [name, input, secret] of secrets) {
    test(`redacts ${name}`, () => {
      const out = redact(input)
      expect(out).not.toContain(secret)
      expect(out).toContain("[REDACTED]")
    })
  }

  test("keeps text around a multiline private key block", () => {
    const out = redact("verify -----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- done")
    expect(out.startsWith("verify ")).toBe(true)
    expect(out.endsWith(" done")).toBe(true)
  })

  test("keeps the scheme and host of a credentialed URL", () => {
    const out = redact("connect postgres://user:pass@db.local/app")
    expect(out).toContain("postgres://")
    expect(out).toContain("@db.local/app")
  })

  test("does not redact a bare Authorization word without a value", () => {
    const input = "the Authorization header was missing"
    expect(redact(input)).toBe(input)
  })

  test("does not redact the plain word token without a value", () => {
    const input = "the token is expired"
    expect(redact(input)).toBe(input)
  })
})
