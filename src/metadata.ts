import type { ActivityEntry } from "./storage.js"

/** Commands whose effect on the project is worth remembering. */
export const SHELL_ALLOW = new Set([
  "git", "bun", "npm", "pnpm", "yarn", "node", "deno", "make", "cmake", "cargo", "go",
  "gradle", "mvn", "tsc", "jest", "vitest", "pytest", "ruff", "mypy", "eslint", "prettier",
  "black", "pip", "pip3", "poetry", "uv", "docker", "docker-compose", "kubectl", "terraform",
  "psql", "mysql", "curl", "wget", "ssh", "scp", "rsync", "rm", "mv", "cp", "mkdir", "touch",
  "chmod", "systemctl", "brew", "apt", "gcc", "clang", "python", "python3",
])

const FILE_TOOLS = new Set(["write", "edit", "patch", "apply_patch", "multiedit"])
const SHELL_TOOLS = new Set(["shell", "bash"])

const HEREDOC = /<<-?\s*['"`]?[A-Za-z_][A-Za-z0-9_]*['"`]?/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Splits a shell command into the segments it actually runs.
 *
 * One scanner handles quoting and substitutions together: a separator only
 * ends a segment when it sits outside quotes and outside a `$( )` group, so a
 * pipe inside a quoted pattern is never mistaken for a separator and a
 * substitution that contains a closing parenthesis cannot unbalance the scan.
 */
function splitSegments(text: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === "\\") {
      current += char
      if (index + 1 < text.length) current += text[++index]!
      continue
    }
    if (char === "$" && text[index + 1] === "(") {
      // Skip the whole substitution, tracking nested parentheses.
      let depth = 1
      let inner = index + 2
      let innerQuote: string | undefined
      while (inner < text.length && depth > 0) {
        const innerChar = text[inner]!
        if (innerQuote) {
          if (innerChar === innerQuote) innerQuote = undefined
        } else if (innerChar === '"' || innerChar === "'") {
          innerQuote = innerChar
        } else if (innerChar === "(") {
          depth++
        } else if (innerChar === ")") {
          depth--
        }
        inner++
      }
      current += " "
      index = inner - 1
      continue
    }
    if (char === "$" && text[index + 1] === "{") {
      const close = text.indexOf("}", index + 2)
      current += " "
      index = close === -1 ? text.length : close
      continue
    }
    if (char === "&" && text[index + 1] === "&") {
      segments.push(current)
      current = ""
      index++
      continue
    }
    if (char === "|" && text[index + 1] === "|") {
      segments.push(current)
      current = ""
      index++
      continue
    }
    if (char === "|" || char === ";" || char === "\n") {
      segments.push(current)
      current = ""
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/**
 * Extracts the command names a shell invocation actually runs.
 *
 * A heredoc body is a script, not commands, so it is cut before the scan.
 */
export function parseShellCommands(command: string): string[] {
  const heredoc = HEREDOC.exec(command)
  const head = heredoc ? command.slice(0, heredoc.index) : command
  const cleaned = head.replace(/`[^`]*`/g, " ")
  const commands: string[] = []
  for (const segment of splitSegments(cleaned)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let index = 0
    while (index < tokens.length && ASSIGNMENT.test(tokens[index]!)) index++
    const first = tokens[index]
    if (first) commands.push(first)
  }
  return commands
}

function toolError(event: { status?: string; error?: unknown }): string | undefined {
  if (event.status !== "error") return undefined
  const error = event.error as { message?: string } | string | undefined
  if (typeof error === "string") return error
  return error?.message ?? "error"
}

/**
 * Turns a finished tool call into the activity worth remembering.
 * Read-only tools and unknown commands contribute nothing; errors always do.
 */
export function classifyToolCall(
  tool: string,
  input: unknown,
  event: { status?: string; error?: unknown },
  turnID?: string,
): Omit<ActivityEntry, "id" | "count" | "createdAt">[] {
  const result: Omit<ActivityEntry, "id" | "count" | "createdAt">[] = []
  const name = tool.toLowerCase()
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {}

  if (FILE_TOOLS.has(name)) {
    const path = args.path ?? args.filePath ?? args.file
    if (typeof path === "string" && path.trim()) result.push({ kind: "file", target: path, turnID })
  } else if (SHELL_TOOLS.has(name)) {
    const command = args.command
    if (typeof command === "string") {
      for (const parsed of parseShellCommands(command)) {
        if (SHELL_ALLOW.has(parsed)) result.push({ kind: "command", target: parsed, turnID })
      }
    }
  }

  const error = toolError(event)
  if (error) result.push({ kind: "error", target: error.slice(0, 200), turnID })

  return result
}
