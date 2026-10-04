import assert from "node:assert/strict"
import { test } from "node:test"
import { prepareSource } from "@opencode/plugin/source.node"

test("loads the documented local plugin through the Node host", async () => {
  const entrypoint = new URL("../.opencode/plugins/opencode-rtk-optimizer.ts", import.meta.url)
  const source = await prepareSource(entrypoint.href, () => {})
  try {
    const module = await source.load()
    assert.equal(module.default.id, "opencode-rtk-optimizer")
    assert.equal(typeof module.default.setup, "function")
    assert.equal(typeof module.default.server, "function")
  } finally {
    source.dispose()
  }
})
