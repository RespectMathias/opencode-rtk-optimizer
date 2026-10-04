import { execFile } from "node:child_process"
import { win32 } from "node:path"

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ExecOptions = { cwd?: string; env?: NodeJS.ProcessEnv }

export type Exec = (command: string, args: string[], timeout: number, options?: ExecOptions) => Promise<ExecResult>

export type Runtime = {
  command?: string
  warning?: string
}

export type Rewrite = {
  changed: boolean
  original: string
  rewritten: string
  exitCode: number
  warning?: string
}

function firstLine(value: string) {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
  if (!line) return
  if (line.length > 1 && ((line[0] === '"' && line.at(-1) === '"') || (line[0] === "'" && line.at(-1) === "'"))) {
    return line.slice(1, -1)
  }
  return line
}

export function createExec(): Exec {
  return (command, args, timeout, options) => new Promise((resolve, reject) => {
    execFile(command, args, { ...options, timeout, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr, exitCode: 0 })
        return
      }
      if (typeof error.code === "number") {
        resolve({ stdout, stderr, exitCode: error.code })
        return
      }
      reject(error)
    })
  })
}

export async function resolveRuntime(exec: Exec, platform = process.platform, options?: ExecOptions): Promise<Runtime> {
  const resolver = platform === "win32"
    ? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")
    : "which"
  let command = "rtk"
  let warning: string | undefined

  try {
    const result = await exec(resolver, [platform === "win32" ? "$PATH:rtk" : "rtk"], 1_000, options)
    const path = firstLine(result.stdout)
    if (result.exitCode === 0 && path) command = path
    else warning = `rtk path lookup failed: ${(result.stderr || result.stdout || `exit ${result.exitCode}`).trim()}`
  } catch (error) {
    warning = `rtk path lookup failed: ${error instanceof Error ? error.message : String(error)}`
  }

  if (platform === "win32" && warning) return { warning: `rtk unavailable: ${warning}` }

  try {
    const result = await exec(command, ["--version"], 1_000, options)
    if (result.exitCode === 0) {
      const runtime: Runtime = { command }
      if (warning) runtime.warning = warning
      return runtime
    }
    return { warning: `rtk unavailable: ${(result.stderr || result.stdout || `exit ${result.exitCode}`).trim()}` }
  } catch (error) {
    return { warning: `rtk unavailable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function resolveRewrite(exec: Exec, command: string, executable: string, options?: ExecOptions): Promise<Rewrite> {
  if (!command.trim() || /^\s*rtk(?:\s|$)/.test(command)) {
    return { changed: false, original: command, rewritten: command, exitCode: 1 }
  }

  try {
    const result = await exec(executable, ["rewrite", command], 3_000, options)
    if (result.exitCode === 1) {
      return { changed: false, original: command, rewritten: command, exitCode: 1 }
    }
    if (result.exitCode === 2) {
      return {
        changed: false,
        original: command,
        rewritten: command,
        exitCode: 2,
        warning: `rtk denied rewrite${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
      }
    }
    if (result.exitCode !== 0 && result.exitCode !== 3) {
      return {
        changed: false,
        original: command,
        rewritten: command,
        exitCode: result.exitCode,
        warning: `rtk rewrite exited with code ${result.exitCode}`,
      }
    }

    const rewritten = result.stdout.trim()
    if (!rewritten) {
      return {
        changed: false,
        original: command,
        rewritten: command,
        exitCode: result.exitCode,
        warning: "rtk rewrite returned no command",
      }
    }
    return {
      changed: rewritten !== command,
      original: command,
      rewritten,
      exitCode: result.exitCode,
    }
  } catch (error) {
    return {
      changed: false,
      original: command,
      rewritten: command,
      exitCode: -1,
      warning: `rtk rewrite failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
