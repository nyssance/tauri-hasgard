import { setTimeout as delay } from "node:timers/promises"

/** @param {number} pid @param {NodeJS.Signals | 0} signal */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    // Darwin can report EPERM while a group contains only exiting/zombie
    // processes. A probe has not established absence: keep waiting for ESRCH.
    // Actual termination permission errors must still propagate.
    if (signal === 0 && error.code === "EPERM") return true
    throw error
  }
}

/** @param {number} pid @param {number} timeoutMs */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) return false
    await delay(25)
  }
  return true
}

/** @param {number} pid */
export async function stopProcessGroup(pid) {
  signalGroup(pid, "SIGTERM")
  if (!(await waitForExit(pid, 5_000))) {
    signalGroup(pid, "SIGKILL")
    if (!(await waitForExit(pid, 5_000))) throw new Error(`Hasgard process group ${pid} survived SIGKILL`)
  }
}
