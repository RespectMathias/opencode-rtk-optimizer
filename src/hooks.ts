import type { Hooks } from "@opencode-ai/plugin"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import { resolveRewrite, resolveRuntime, type Exec, type ExecOptions } from "./rewrite.js"

export type Notice = (message: string, variant: "info" | "warning") => Promise<void>

type Call = {
  original: string
  rewritten: string
}

const RUNTIME_TTL = 30_000
const MAX_CALLS = 1_000

function key(sessionID: string, callID: string) {
  return `${sessionID}\0${callID}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function createRewriter(exec: Exec, notify: Notice = async () => {}) {
  const warned = new Set<string>()
  let runtime: { scope?: string; command?: string; expires: number } = { expires: 0 }
  let probe: { scope: string; result: Promise<string | undefined> } | undefined

  const warn = async (message: string) => {
    if (warned.has(message)) return
    warned.add(message)
    console.warn(`[opencode-rtk-optimizer] ${message}`)
    await notify(message, "warning")
  }

  return async (command: string, options?: ExecOptions) => {
    const scope = JSON.stringify([options?.cwd, options?.env])
    let rtk = runtime.command
    if (runtime.scope !== scope || Date.now() >= runtime.expires) {
      if (probe?.scope !== scope) {
        const pending = resolveRuntime(exec, process.platform, options).then(async (result) => {
          runtime = { scope, command: result.command, expires: Date.now() + RUNTIME_TTL }
          if (result.warning) await warn(result.warning)
          return result.command
        }).finally(() => {
          if (probe?.result === pending) probe = undefined
        })
        probe = { scope, result: pending }
      }
      rtk = await probe.result
    }
    if (!rtk) return
    const result = await resolveRewrite(exec, command, rtk, options)
    if (result.exitCode === 2) throw new Error(result.warning ?? "rtk denied rewrite")
    if (result.warning) await warn(result.warning)
    return result
  }
}

export function createShellHook(exec: Exec) {
  const rewrite = createRewriter(exec)
  return async (event: ShellCreateBefore) => {
    const result = await rewrite(event.command, { cwd: event.cwd, env: event.env })
    if (result?.changed) event.command = result.rewritten
  }
}

export function createHooks(exec: Exec, notify: Notice = async () => {}): Hooks {
  const calls = new Map<string, Call>()
  const rewrite = createRewriter(exec, notify)
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash" || !record(output.args)) return
      const command = output.args.command
      if (typeof command !== "string") return

      const result = await rewrite(command)
      if (!result?.changed) return

      if (calls.size >= MAX_CALLS) calls.delete(calls.keys().next().value!)
      calls.set(key(input.sessionID, input.callID), {
        original: result.original,
        rewritten: result.rewritten,
      })
      output.args.command = result.rewritten
      await notify(`${result.original} -> ${result.rewritten}`, "info")
    },
    "tool.execute.after": async (input, output) => {
      const id = key(input.sessionID, input.callID)
      const call = calls.get(id)
      if (!call || !record(input.args)) return

      input.args.command = call.original
      output.metadata = {
        ...(record(output.metadata) ? output.metadata : {}),
        openrtk: {
          original: call.original,
          rewritten: call.rewritten,
        },
      }

      const exit = record(output.metadata) && typeof output.metadata.exit === "number" ? output.metadata.exit : undefined
      if (!output.output && exit === 0) output.output = "(no output)"
      if (!output.output && exit !== undefined && exit !== 0) output.output = `(no output)\n\nCommand exited with code ${exit}`
      if (output.output && exit !== undefined && exit !== 0 && !output.output.includes(`Command exited with code ${exit}`)) {
        output.output += `\n\nCommand exited with code ${exit}`
      }
      calls.delete(id)
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      for (const message of output.messages) {
        for (const part of message.parts) {
          if (part.type !== "tool" || part.tool !== "bash" || !record(part.state.input)) continue
          const state = calls.get(key(part.sessionID, part.callID))
          const metadata = "metadata" in part.state && record(part.state.metadata) ? part.state.metadata : undefined
          const saved = metadata && record(metadata.openrtk) && typeof metadata.openrtk.original === "string"
            ? metadata.openrtk.original
            : undefined
          const original = saved ?? state?.original
          if (original) part.state.input.command = original
        }
      }
    },
  }
}
