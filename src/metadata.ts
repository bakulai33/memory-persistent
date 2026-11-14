import type { ActivityEntry } from "./storage.js"
import { redact } from "./redact.js"

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
const READONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "branch", "remote", "blame", "describe",
])

const READONLY_COMMANDS = new Set(["ls", "cat", "grep", "find", "head", "tail"])

// Git global options that consume the following token as their value.
const GIT_VALUE_FLAGS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
  "--exec-path", "--config-env", "--attr-source",
])

interface ShellCommandDetail {
  binary: string
  subcommand: string | null
}

function shellCommandDetails(command: string): ShellCommandDetail[] {
  const heredoc = HEREDOC.exec(command)
  const head = heredoc ? command.slice(0, heredoc.index) : command
  const cleaned = head.replace(/`[^`]*`/g, " ")
  const details: ShellCommandDetail[] = []
  for (const segment of splitSegments(cleaned)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let index = 0
    while (index < tokens.length && ASSIGNMENT.test(tokens[index]!)) index++
    const binary = tokens[index]
    if (!binary) continue
    let cursor = index + 1
    let subcommand: string | null = null
    while (cursor < tokens.length) {
      const token = tokens[cursor]!
      if (!token.startsWith("-")) {
        subcommand = token
        break
      }
      if (token.includes("=")) {
        cursor += 1
        continue
      }
      if (binary === "git") {
        const matchedFlag = [...GIT_VALUE_FLAGS].find(
          (flag) => token === flag || token.startsWith(flag),
        )
        if (matchedFlag && token === matchedFlag) {
          cursor += 2
          continue
        }
        if (matchedFlag) {
          cursor += 1
          continue
        }
      }
      cursor += 1
    }
    details.push({ binary, subcommand })
  }
  return details
}

export function parseShellCommands(command: string): string[] {
  return shellCommandDetails(command).map((detail) => detail.binary)
}

function toolError(event: { status?: string; error?: unknown }): string | undefined {
  if (event.status !== "error") return undefined
  const error = event.error as { message?: string } | string | undefined
  if (typeof error === "string") return error
  return error?.message ?? "error"
}

/** Batas panjang target activity; di atas ini itu bukan path/pesan ringkas. */
const MAX_TARGET_CHARS = 400

/**
 * Menormalisasi target activity sebelum disimpan.
 *
 * - `file`   : hanya path — ambil baris pertama, buang sisa blok argumen
 *              (oldString=/newString=), tolak yang bukan path.
 * - `error`  : newlines -> spasi (tool error bisa memuat body skrip).
 * - `command`: tidak diubah (sudah dibatasi classifier).
 *
 * Catatan: `redact()` TIDAK boleh dipakai di sini untuk `file` — ia merusak path
 * kode (mis. "token = tokens[cursor]!" -> "[REDACTED]").
 */
export function normalizeActivityTarget(kind: "file" | "command" | "error", target: string): string {
  if (kind === "file") {
    const firstLine = target.split("\n", 1)[0]!.trim()
    const cleaned = firstLine
      .replace(/oldString=.*$/s, "")
      .replace(/newString=.*$/s, "")
      .trim()
    if (!cleaned || cleaned.length > MAX_TARGET_CHARS) return ""
    return cleaned
  }
  if (kind === "error") {
    const flattened = target.replace(/\s+/g, " ").trim()
    return flattened.length > MAX_TARGET_CHARS ? `${flattened.slice(0, MAX_TARGET_CHARS)}…` : flattened
  }
  return target
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
    if (typeof path === "string" && path.trim()) {
      const fileTarget = normalizeActivityTarget("file", path)
      if (fileTarget) result.push({ kind: "file", target: fileTarget, command: null, turnID })
    }
  } else if (SHELL_TOOLS.has(name)) {
    const command = args.command
    if (typeof command === "string") {
      for (const detail of shellCommandDetails(command)) {
        const binary = detail.binary
        if (!SHELL_ALLOW.has(binary)) continue
        if (READONLY_COMMANDS.has(binary)) continue
        if (binary === "git" && detail.subcommand !== null && READONLY_GIT_SUBCOMMANDS.has(detail.subcommand)) continue
        const target = detail.subcommand ? `${binary} ${detail.subcommand}` : binary
        result.push({ kind: "command", target, command: binary, turnID })
      }
    }
  }

  const error = toolError(event)
  // A provider or a tool error can carry a credential, so it is redacted
  // before it is stored. The redaction runs before the cap, so a secret is
  // removed instead of being cut in half.
  if (error) result.push({ kind: "error", target: normalizeActivityTarget("error", redact(error).slice(0, 200)), command: null, turnID })

  return result
}
