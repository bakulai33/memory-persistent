import { describe, test, expect } from "bun:test"
import { parseShellCommands, classifyToolCall, SHELL_ALLOW } from "../src/metadata"

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
})
