// OpenCode plugin installed by stam into its private OpenCode server's config folder.
// It asks the stam daemon, per session, for mail notices to append after tool calls
// and for the stam system prompt to add to each model request.
// @ts-expect-error OpenCode provides @opencode/plugin when it loads this file; it is not a stam dependency
import { Plugin } from "@opencode/plugin"

const URL = process.env.STAM_URL
const TOKEN = process.env.STAM_TOKEN

async function get(path: string): Promise<any> {
  try {
    const r = await fetch(URL + path, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(2000) })
    return r.ok ? await r.json() : undefined
  } catch {
    return undefined
  }
}

export default Plugin.define({
  id: "stam",
  async setup(ctx: any) {
    await ctx.tool.hook("execute.after", async (event: any) => {
      if (event.status !== "completed") return
      const r = await get(`/api/by-session/${event.sessionID}/notice`)
      if (r?.text) event.result = { ...event.result, content: [...(event.result?.content ?? []), { type: "text", text: `\n\n${r.text}` }] }
    })
    // Instructions an agent gave compact_self; pushing to event.system is ignored here.
    await ctx.session.hook("compaction", async (event: any) => {
      const r = await get(`/api/by-session/${event.sessionID}/compact-instructions`)
      if (r?.text && Array.isArray(event.messages))
        event.messages.push({ role: "user", content: [{ type: "text", text: `Extra instructions for the summary you are about to write: ${r.text}` }] })
    })
    await ctx.session.hook("context", async (event: any) => {
      const r = await get(`/api/by-session/${event.sessionID}/system`)
      // System entries are { type, text } parts, not strings.
      if (r?.text && Array.isArray(event.system)) event.system.push({ type: "text", text: r.text })
    })
  },
})
