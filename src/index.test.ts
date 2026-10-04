import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "./index.js"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import type { Plugin } from "@opencode/plugin"
import { createHooks, createShellHook } from "./hooks.js"
import { createExec, resolveRewrite, resolveRuntime, type Exec } from "./rewrite.js"

function result(stdout = "", stderr = "", exitCode = 0) {
  return { stdout, stderr, exitCode }
}

describe("plugin entrypoint", () => {
  test("loads as a V2 definition with a V1 server entrypoint", () => {
    assert.equal(typeof plugin, "object")
    assert.equal(plugin.id, "opencode-rtk-optimizer")
    assert.equal(typeof plugin.setup, "function")
    assert.equal(typeof plugin.server, "function")
  })

  test("registers rewriting on the V2 shell domain", async () => {
    const registrations: { name: string; callback: unknown }[] = []
    await plugin.setup({ shell: {
      hook: async (name: string, callback: unknown) => { registrations.push({ name, callback }) },
    } } as unknown as Plugin.Context)
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].name, "create.before")
    assert.equal(typeof registrations[0].callback, "function")
  })
})

describe("V2 shell hook", () => {
  function event(command = "git status"): ShellCreateBefore {
    return { command, cwd: process.cwd(), timeout: 1234, shell: "pwsh", env: { PATH: "test-path" } }
  }

  test("rewrites execution without changing the source tool input", async () => {
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") return result("rtk 0.51.0")
      assert.deepEqual(args, ["rewrite", "git status"])
      return result("rtk git status", "", 3)
    }
    const hook = createShellHook(exec)
    const input = { command: "git status" }
    const invocation = event(input.command)
    const original = { ...invocation }
    await hook(invocation)
    assert.deepEqual(invocation, { ...original, command: "rtk git status" })
    assert.equal(input.command, "git status")
  })

  test("defers Claude deny rules to native OpenCode permissions", async () => {
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") return result("rtk 0.51.0")
      return result("", "", 2)
    }
    const hook = createShellHook(exec)
    const invocation = event("git push")
    await hook(invocation)
    assert.equal(invocation.command, "git push")
  })

  test("leaves unsupported commands unchanged", async () => {
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") return result("rtk 0.51.0")
      return result("", "", 1)
    }
    const hook = createShellHook(exec)
    const invocation = event("echo ok")
    await hook(invocation)
    assert.equal(invocation.command, "echo ok")
  })

  test("keeps concurrent invocations isolated and shares runtime probing", async () => {
    let probes = 0
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") {
        probes++
        return result("rtk 0.51.0")
      }
      return result(`rtk ${args[1]}`, "", 3)
    }
    const hook = createShellHook(exec)
    const first = event("git diff")
    const second = event("git status")
    await Promise.all([hook(first), hook(second)])
    assert.equal(first.command, "rtk git diff")
    assert.equal(second.command, "rtk git status")
    assert.equal(probes, 1)
  })

  test("probes and rewrites in the shell working directory and environment", async () => {
    const invocation = event()
    invocation.env.RTK_TEST_VALUE = "session value"
    const exec: Exec = async (_command, args, _timeout, options) => {
      assert.deepEqual(options, { cwd: invocation.cwd, env: invocation.env })
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") return result("rtk 0.51.0")
      return result("rtk git status", "", 3)
    }
    await createShellHook(exec)(invocation)
    assert.equal(invocation.command, "rtk git status")
  })

  test("does not reuse an executable from a different shell environment", async () => {
    let probes = 0
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") {
        probes++
        return result("rtk 0.51.0")
      }
      return result(`rtk ${args[1]}`, "", 3)
    }
    const hook = createShellHook(exec)
    const first = event()
    const second = event()
    second.env.PATH = "different path"
    await hook(first)
    await hook(second)
    assert.equal(probes, 2)
  })

  test("recovers after the cached unavailable runtime expires", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000 })
    const warnings: string[] = []
    t.mock.method(console, "warn", (message: string) => warnings.push(message))
    let available = false
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") return available ? result("rtk 0.51.0") : result("", "not found", 1)
      return result("rtk git status", "", 3)
    }
    const hook = createShellHook(exec)
    const first = event()
    await hook(first)
    assert.equal(first.command, "git status")
    available = true
    const cached = event()
    await hook(cached)
    assert.equal(cached.command, "git status")
    t.mock.timers.tick(30_001)
    const recovered = event()
    await hook(recovered)
    assert.equal(recovered.command, "rtk git status")
    assert.equal(warnings.length, 1)
  })

  test("fails open on rewrite timeout and warns only once", async (t) => {
    const warnings: string[] = []
    t.mock.method(console, "warn", (message: string) => warnings.push(message))
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") return result("rtk 0.51.0")
      throw new Error("rewrite timed out")
    }
    const hook = createShellHook(exec)
    const first = event()
    const second = event()
    await hook(first)
    await hook(second)
    assert.equal(first.command, "git status")
    assert.equal(second.command, "git status")
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /rewrite timed out/)
  })
})

describe("createExec", () => {
  test("passes argv boundaries and caller environment to the child", async () => {
    const exec = createExec()
    const execution = await exec(process.execPath, ["-e",
      "console.log(JSON.stringify({ cwd: process.cwd(), value: process.env.RTK_TEST_VALUE, args: process.argv.slice(1) }))",
      "space value", "literal $value; &&", 'quote"value'], 3_000,
      { cwd: process.cwd(), env: { ...process.env, RTK_TEST_VALUE: "session value" } },
    )
    assert.equal(execution.exitCode, 0)
    assert.deepEqual(JSON.parse(execution.stdout), {
      cwd: process.cwd(), value: "session value", args: ["space value", "literal $value; &&", 'quote"value'],
    })
  })
})

describe("resolveRuntime", () => {
  test("does not fall back to a Windows cwd executable when PATH lookup fails", async () => {
    const calls: string[] = []
    const exec: Exec = async (command) => {
      calls.push(command)
      return command.endsWith("where.exe") ? result("", "not found", 1) : result("rtk 0.51.0")
    }
    const runtime = await resolveRuntime(exec, "win32")
    assert.equal(runtime.command, undefined)
    assert.equal(calls.length, 1)
    assert.match(runtime.warning!, /rtk unavailable/)
  })

  test("resolves Windows RTK from PATH without running cwd executables", { skip: process.platform !== "win32" }, async (t) => {
    const base = join(tmpdir(), "opencode")
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, "rtk-path-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const cwd = join(root, "untrusted")
    const trusted = join(root, "trusted")
    await mkdir(cwd)
    await mkdir(trusted)
    await copyFile(process.execPath, join(cwd, "rtk.exe"))
    await copyFile(process.execPath, join(cwd, "where.exe"))
    await copyFile(process.execPath, join(trusted, "rtk.exe"))
    const runtime = await resolveRuntime(createExec(), "win32", { cwd, env: { PATH: trusted, PATHEXT: ".EXE" } })
    assert.equal(runtime.command, join(trusted, "rtk.exe"))
    await rm(join(trusted, "rtk.exe"))
    const missing = await resolveRuntime(createExec(), "win32", { cwd, env: { PATH: trusted, PATHEXT: ".EXE" } })
    assert.equal(missing.command, undefined)
  })

  test("resolves and validates rtk on Windows", async () => {
    const calls: [string, string[]][] = []
    const exec: Exec = async (command, args) => {
      calls.push([command, args])
      if (command.endsWith("\\System32\\where.exe")) return result('"C:\\Program Files\\rtk.exe"\r\n')
      return result("rtk 1.0.0")
    }

    assert.deepEqual(await resolveRuntime(exec, "win32"), { command: "C:\\Program Files\\rtk.exe" })
    assert.match(calls[0][0], /^[A-Za-z]:\\.+\\System32\\where\.exe$/)
    assert.deepEqual(calls[0][1], ["$PATH:rtk"])
    assert.deepEqual(calls.slice(1), [["C:\\Program Files\\rtk.exe", ["--version"]]])
  })

  test("reports unavailable rtk", async () => {
    const exec: Exec = async () => result("", "not found", 1)
    assert.deepEqual(await resolveRuntime(exec, "linux"), { warning: "rtk unavailable: not found" })
  })
})

describe("resolveRewrite", () => {
  test("passes complete command as one argument", async () => {
    const calls: [string, string[]][] = []
    const exec: Exec = async (command, args) => {
      calls.push([command, args])
      return result("rtk git diff --stat; if ($?) { git diff }\n")
    }

    const command = "git diff --stat; if ($?) { git diff }"
    assert.deepEqual(await resolveRewrite(exec, command, "C:\\rtk.exe"), {
      changed: true,
      original: command,
      rewritten: "rtk git diff --stat; if ($?) { git diff }",
      exitCode: 0,
    })
    assert.deepEqual(calls, [["C:\\rtk.exe", ["rewrite", command]]])
  })

  test("accepts rtk rewrite exit code 3", async () => {
    const exec: Exec = async () => result("rtk git status", "", 3)
    assert.equal((await resolveRewrite(exec, "git status", "rtk")).changed, true)
  })

  test("leaves no-match and denied commands unchanged", async () => {
    const noMatch: Exec = async () => result("", "", 1)
    const denied: Exec = async () => result("", "unsafe rewrite", 2)
    assert.deepEqual(await resolveRewrite(noMatch, "echo ok", "rtk"), {
      changed: false,
      original: "echo ok",
      rewritten: "echo ok",
      exitCode: 1,
    })
    assert.deepEqual(await resolveRewrite(denied, "git push", "rtk"), {
      changed: false,
      original: "git push",
      rewritten: "git push",
      exitCode: 2,
      warning: "rtk denied rewrite: unsafe rewrite",
    })
  })

  test("does not invoke rewrite for direct rtk commands", async () => {
    let invoked = false
    const exec: Exec = async () => {
      invoked = true
      return result()
    }
    assert.equal((await resolveRewrite(exec, "rtk git diff", "rtk")).changed, false)
    assert.equal(invoked, false)
  })

  test("fails open on timeout and empty rewrite output", async () => {
    const timeout: Exec = async () => {
      throw new Error("command timed out after 3000 ms")
    }
    const empty: Exec = async () => result("", "", 3)
    assert.deepEqual(await resolveRewrite(timeout, "git diff", "rtk"), {
      changed: false,
      original: "git diff",
      rewritten: "git diff",
      exitCode: -1,
      warning: "rtk rewrite failed: command timed out after 3000 ms",
    })
    assert.deepEqual(await resolveRewrite(empty, "git diff", "rtk"), {
      changed: false,
      original: "git diff",
      rewritten: "git diff",
      exitCode: 3,
      warning: "rtk rewrite returned no command",
    })
  })
})

describe("plugin lifecycle", () => {
  test("defers Claude deny rules to V1 OpenCode permissions", async () => {
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rtk" || args[0] === "$PATH:rtk") return result("rtk\n")
      if (args[0] === "--version") return result("rtk 0.51.0")
      return result("", "rtk denied rewrite", 2)
    }
    const hooks = createHooks(exec)
    const args = { command: "git push" }
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "deny" }, { args })
    assert.equal(args.command, "git push")
  })

  function setup(rewritten = "rtk git diff") {
    const notices: string[] = []
    const exec: Exec = async (command, args) => {
      if (command.endsWith("where.exe") || command === "which") return result("C:\\rtk.exe\n")
      if (args[0] === "--version") return result("rtk 1.0.0")
      return result(`${rewritten}\n`)
    }
    const hooks = createHooks(exec, async (message) => {
      notices.push(message)
    })
    return { hooks, notices }
  }

  test("executes rewrite while restoring model-facing command", async () => {
    const { hooks, notices } = setup()
    const args = { command: "git diff", description: "Get changes" }
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "session", callID: "call" },
      { args },
    )
    assert.equal(args.command, "rtk git diff")

    const output = { title: "Get changes", output: "compressed diff", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "session", callID: "call", args },
      output,
    )
    assert.equal(args.command, "git diff")
    assert.equal(output.output, "compressed diff")
    assert.deepEqual(output.metadata, {
      exit: 0,
      openrtk: { original: "git diff", rewritten: "rtk git diff" },
    })
    assert.ok(notices.includes("git diff -> rtk git diff"))
  })

  test("restores persisted rewritten commands before model conversion", async () => {
    const { hooks } = setup()
    const args = { command: "git diff" }
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "session", callID: "call" },
      { args },
    )

    const part = {
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "tool" as const,
      tool: "bash",
      callID: "call",
      state: {
        status: "running" as const,
        input: { command: "rtk git diff" },
        time: { start: Date.now() },
      },
    }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {} as never, parts: [part] }],
    })
    assert.equal(part.state.input.command, "git diff")
  })

  test("uses persisted provenance after successful call state is released", async () => {
    const { hooks } = setup()
    const args = { command: "git diff" }
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "session", callID: "call" },
      { args },
    )
    const output = { title: "", output: "diff", metadata: { exit: 0 } }
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "session", callID: "call", args },
      output,
    )

    const part = {
      id: "part",
      sessionID: "session",
      messageID: "message",
      type: "tool" as const,
      tool: "bash",
      callID: "call",
      state: {
        status: "completed" as const,
        input: { command: "rtk git diff" },
        output: "diff",
        title: "",
        metadata: output.metadata,
        time: { start: Date.now(), end: Date.now() },
      },
    }
    await hooks["experimental.chat.messages.transform"]?.({}, {
      messages: [{ info: {} as never, parts: [part] }],
    })
    assert.equal(part.state.input.command, "git diff")
  })

  test("marks silent success and exposes command failures", async () => {
    const success = setup()
    const successArgs = { command: "git diff" }
    await success.hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "session", callID: "success" },
      { args: successArgs },
    )
    const successOutput = { title: "", output: "", metadata: { exit: 0 } }
    await success.hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "session", callID: "success", args: successArgs },
      successOutput,
    )
    assert.equal(successOutput.output, "(no output)")

    const failure = setup()
    const failureArgs = { command: "git diff" }
    await failure.hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "session", callID: "failure" },
      { args: failureArgs },
    )
    const failureOutput = { title: "", output: "fatal", metadata: { exit: 7 } }
    await failure.hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "session", callID: "failure", args: failureArgs },
      failureOutput,
    )
    assert.equal(failureOutput.output, "fatal\n\nCommand exited with code 7")
  })

  test("keeps parallel calls isolated", async () => {
    const exec: Exec = async (command, args) => {
      if (command.endsWith("where.exe") || command === "which") return result("rtk\n")
      if (args[0] === "--version") return result("rtk 1.0.0")
      return result(`rtk ${args[1]}\n`)
    }
    const hooks = createHooks(exec)
    const first = { command: "git diff" }
    const second = { command: "git status" }
    await Promise.all([
      hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "s", callID: "1" }, { args: first }),
      hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "s", callID: "2" }, { args: second }),
    ])
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "s", callID: "2", args: second },
      { title: "", output: "ok", metadata: { exit: 0 } },
    )
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "s", callID: "1", args: first },
      { title: "", output: "ok", metadata: { exit: 0 } },
    )
    assert.equal(first.command, "git diff")
    assert.equal(second.command, "git status")
  })
})
