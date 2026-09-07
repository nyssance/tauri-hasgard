// Runs independently of the Playwright worker. Keep ownership of the application
// group until the worker releases it, including when the worker is SIGKILLed.

import { spawn } from "node:child_process"
import { lstatSync, unlinkSync } from "node:fs"
import { createConnection } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { stopProcessGroup } from "./process-group.js"

let application
let starting = false
let stopping
let endpoint
let initialEndpoint
let ownedEndpoint
let endpointWatch

function identity(path) {
  try {
    const stat = lstatSync(path)
    return { dev: stat.dev, ino: stat.ino, socket: stat.isSocket() }
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

function sameIdentity(first, second) {
  return first && second && first.dev === second.dev && first.ino === second.ino
}

function captureEndpoint() {
  if (ownedEndpoint || !endpoint) return
  const current = identity(endpoint)
  if (current?.socket && !sameIdentity(current, initialEndpoint)) {
    ownedEndpoint = current
    clearInterval(endpointWatch)
  }
}

async function removeOwnedEndpoint() {
  if (!ownedEndpoint || !sameIdentity(identity(endpoint), ownedEndpoint)) return
  // An escaped process could still hold the socket open. Never unlink an
  // accepting endpoint, even when its inode matches the original application.
  const accepting = await new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", error => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false)
      else reject(error)
    })
    socket.setTimeout(1_000, () => {
      socket.destroy()
      reject(new Error("Endpoint cleanup probe timed out"))
    })
  })
  if (!accepting && sameIdentity(identity(endpoint), ownedEndpoint)) {
    try {
      unlinkSync(endpoint)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}

// The worker may also have owned stderr's reader. Losing diagnostics must not
// terminate the process responsible for orphan cleanup.
process.stderr.on("error", error => {
  if (error.code !== "EPIPE") shutdown(1)
})

function send(message, stream) {
  if (!process.connected) return
  const writable = process.send(message, error => {
    if (error) {
      if (error.code !== "ERR_IPC_CHANNEL_CLOSED" && error.code !== "EPIPE")
        process.stderr.write(`Hasgard supervisor IPC: ${error.message}\n`)
      if (process.connected) process.disconnect()
    } else stream?.resume()
  })
  if (!writable) stream?.pause()
}

process.once("message", config => {
  if (!process.connected || stopping) return
  starting = true
  try {
    endpoint = config.env.TAURI_HASGARD_SOCKET
    if (typeof endpoint !== "string" || !endpoint) throw new Error("Supervisor requires TAURI_HASGARD_SOCKET")
    initialEndpoint = identity(endpoint)
    endpointWatch = setInterval(captureEndpoint, 25)
    process.on("message", message => {
      if (message.type !== "endpoint") return
      const current = identity(endpoint)
      if (!current?.socket || !sameIdentity(current, message.identity)) {
        send({ type: "error", message: "Application endpoint changed during readiness" })
        return
      }
      ownedEndpoint = current
      clearInterval(endpointWatch)
      send({ type: "endpoint-owned" })
    })
    application = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: config.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    })
    application.stdout.on("data", chunk => send({ type: "stdout", data: chunk.toString() }, application.stdout))
    application.stderr.on("data", chunk => send({ type: "stderr", data: chunk.toString() }, application.stderr))
    application.once("spawn", () => send({ type: "started", pid: application.pid }))
    application.once("error", error => send({ type: "error", message: error.message, code: error.code }))
    application.once("close", (code, signal) => send({ type: "exit", code, signal }))
  } catch (error) {
    send({ type: "error", message: error.message, code: error.code })
  }
})

process.once("disconnect", () => shutdown(0))
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown(0))
process.on("uncaughtException", error => {
  process.stderr.write(`Hasgard supervisor error: ${error.stack}\n`)
  shutdown(1)
})
process.on("unhandledRejection", error => {
  process.stderr.write(`Hasgard supervisor rejection: ${String(error)}\n`)
  shutdown(1)
})

function shutdown(exitCode) {
  if (!stopping) stopping = cleanup(exitCode)
}

async function cleanup(exitCode) {
  clearInterval(endpointWatch)
  const pid = application?.pid
  if (!starting || pid === undefined) process.exit(exitCode)
  let groupStopped = false
  let endpointFailures = 0
  // Once the owner is gone, there is nobody to retry a cleanup failure. Keep
  // ownership and retry rather than abandoning a potentially live process group.
  for (;;) {
    try {
      let endpointError
      try {
        captureEndpoint()
      } catch (error) {
        endpointError = error
      }
      // A metadata failure must not bypass process termination. Retain and
      // report it after stopping the group, then retry endpoint cleanup.
      if (!groupStopped) {
        await stopProcessGroup(pid)
        groupStopped = true
      }
      if (endpointError) throw endpointError
      await removeOwnedEndpoint()
      process.exit(exitCode)
    } catch (error) {
      process.stderr.write(`Hasgard orphan cleanup: ${error.message}\n`)
      // Once no application group remains, a permanently inaccessible socket
      // must not keep this supervisor alive or cause signals to a reused PID.
      if (groupStopped && ++endpointFailures >= 3) process.exit(1)
      await delay(1_000)
    }
  }
}
