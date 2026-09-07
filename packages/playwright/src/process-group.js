import { setTimeout as delay } from "node:timers/promises"

/** @param {number} pid @param {NodeJS.Signals | 0} signal */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
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
