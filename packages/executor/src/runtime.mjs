import { createInterface } from "node:readline"
import { act } from "./actions.mjs"

export async function run(chromium) {
// The host supplies a single native page's CDP stream over stdio. There is no
// listening port, browser launch, profile or application-specific model here.
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const root = "hasgard-page"
let attached = false
let targetInfo
let browser
let page
const transport = {
  send(message) {
    const { id, method, params = {}, sessionId } = message
    const reply = (result) => queueMicrotask(() => transport.onmessage({ id, result }))
    if (!sessionId) {
      if (method === "Target.getTargetInfo") return reply({ targetInfo })
      if (method === "Target.getTargets") return reply({ targetInfos: [targetInfo] })
      if (method === "Target.setAutoAttach" && params.autoAttach && params.flatten) {
        if (!attached) {
          attached = true
          queueMicrotask(() =>
            transport.onmessage({
              method: "Target.attachedToTarget",
              params: {
                sessionId: root,
                targetInfo,
                waitingForDebugger: false
              }
            })
          )
        }
        return reply({})
      }
      if (method !== "Browser.getVersion") {
        return queueMicrotask(() =>
          transport.onmessage({
            id,
            error: {
              code: -32601,
              message: `Browser-wide operation unavailable: ${method}`
            }
          })
        )
      }
    }
    output({
      kind: "cdp",
      message: { ...message, ...(sessionId === root ? { sessionId: undefined } : {}) },
      root: sessionId === root
    })
  },
  close() {
    transport.onclose?.()
  }
}

let actions = Promise.resolve()
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line)
  if (message.kind === "cdp") {
    const event = message.message
    if (message.root || (!event.id && !event.sessionId)) event.sessionId = root
    transport.onmessage?.(event)
    continue
  }
  // CDP events keep flowing while actions execute; writes on this page are serial.
  actions = actions.then(async () => {
    try {
      if (message.kind === "init") {
        targetInfo = message.targetInfo
        browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 10000 })
        const pages = browser.contexts().flatMap((context) => context.pages())
        if (pages.length !== 1) throw Error(`Expected one native webview, found ${pages.length}`)
        page = pages[0]
        // Native dialogs belong to the application/user. Playwright otherwise
        // auto-dismisses them when no listener exists, changing business behavior.
        page.on("dialog", () => {})
        output({ kind: "result", id: message.id, result: { ok: true } })
      } else if (message.kind === "action") {
        if (!page) throw Error("Executor has not attached")
        output({ kind: "result", id: message.id, result: await act(page, message.method, message.params) })
      } else throw Error(`Unknown executor message: ${message.kind}`)
    } catch (error) {
      output({ kind: "result", id: message.id, error: String(error) })
    }
  })
}
transport.onclose?.("Native host closed")
await actions
await browser?.close()

}
