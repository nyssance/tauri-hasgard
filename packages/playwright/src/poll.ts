// A condition that is about to become true usually does so within a frame or
// two, so the first re-reads come quickly; after that the interval settles so a
// long wait does not flood the application with round trips.
const POLL_INTERVALS_MS = [10, 20, 50]

/** Delay before re-read number `attempt` (zero-based), capped by the time left until `deadline`. */
export function pollDelay(attempt: number, deadline: number): number {
  const interval = POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]
  return Math.min(interval, Math.max(0, deadline - Date.now()))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
