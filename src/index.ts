import type { Plugin } from "@opencode/plugin"
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import { createHooks, createShellHook, type Notice } from "./hooks.js"
import { createExec } from "./rewrite.js"

export const rtkPlugin: V1Plugin = async ({ client, directory }) => {
  const notify: Notice = async (message, variant) => {
    await client.tui.showToast({
      body: {
        title: "opencode-rtk-optimizer",
        message,
        variant,
        duration: variant === "info" ? 3_000 : 6_000,
      },
      query: { directory },
    }).catch(() => {})
  }

  return createHooks(createExec(), notify)
}

export default {
  id: "opencode-rtk-optimizer",
  async setup(ctx: Plugin.Context) {
    await ctx.shell.hook("create.before", createShellHook(createExec()))
  },
  server: rtkPlugin,
} satisfies Plugin.Plugin & { server: V1Plugin }
