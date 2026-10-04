import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createShellHook } from "./hooks.js"
import { createExec, resolveRewrite, resolveRuntime } from "./rewrite.js"

test("native RTK compatibility", async (t) => {
  const base = join(tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const cwd = await mkdtemp(join(base, "rtk-compat-"))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(cwd, ".claude"),
    RTK_DB_PATH: join(cwd, "rtk.db"),
    RTK_TEE: "0",
    RTK_RECALL: "0",
  }
  const options = { cwd, env }
  const exec = createExec()
  await mkdir(env.CLAUDE_CONFIG_DIR)
  const settings = join(env.CLAUDE_CONFIG_DIR, "settings.json")
  await writeFile(settings, JSON.stringify({ permissions: { allow: ["Bash(git *)"] } }))
  const runtime = await resolveRuntime(exec, process.platform, options)
  assert.ok(runtime.command, runtime.warning ?? "RTK is required for compatibility tests")
  t.diagnostic((await exec(runtime.command, ["--version"], 1_000, options)).stdout.trim())

  await t.test("rewrites quoted arguments and compound commands through the installed registry", async () => {
    for (const [command, expected] of [
      ["git status", "rtk git status"],
      ['git diff -- "file with spaces.txt"', 'rtk git diff -- "file with spaces.txt"'],
      ["git status && git diff", "rtk git status && rtk git diff"],
    ]) {
      const result = await resolveRewrite(exec, command, runtime.command!, options)
      assert.equal(result.rewritten, expected)
      assert.ok(result.changed)
    }
  })

  await t.test("honors native allow, ask, deny, and no-match exit codes", async () => {
    assert.equal((await resolveRewrite(exec, "git status", runtime.command!, options)).exitCode, 0)
    await writeFile(settings, JSON.stringify({ permissions: { ask: ["Bash(git *)"] } }))
    assert.equal((await resolveRewrite(exec, "git status", runtime.command!, options)).exitCode, 3)
    await writeFile(settings, JSON.stringify({ permissions: { deny: ["Bash(git *)"] } }))
    const invocation = { command: "git status", cwd, env, shell: "sh", timeout: 1_000 }
    assert.equal((await resolveRewrite(exec, "git status", runtime.command!, options)).exitCode, 2)
    await createShellHook(exec)(invocation)
    assert.equal(invocation.command, "git status")
    await writeFile(settings, "{}")
    assert.equal((await resolveRewrite(exec, "echo hello", runtime.command!, options)).exitCode, 1)
  })

  await t.test("preserves generic runner argv boundaries in RTK 0.51", async () => {
    const script = join(cwd, "argv.cjs")
    await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)))")
    const result = await exec(runtime.command!, ["test", process.execPath, script,
      "two words", "literal $value; &&", 'quote"value'], 10_000, options)
    assert.equal(result.exitCode, 0, result.stderr)
    assert.ok(result.stdout.includes(JSON.stringify(["two words", "literal $value; &&", 'quote"value'])), result.stdout)
  })
})
