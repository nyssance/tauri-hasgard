import { expect, test, vi } from "vitest"
import { stopProcessGroup } from "./process-group.js"

function failure(code: string) {
  return Object.assign(new Error(code), { code })
}

test("waits through an EPERM existence probe until the group is absent", async () => {
  const kill = vi
    .spyOn(process, "kill")
    .mockImplementationOnce(() => true)
    .mockImplementationOnce(() => {
      throw failure("EPERM")
    })
    .mockImplementationOnce(() => {
      throw failure("ESRCH")
    })
  await stopProcessGroup(12345)
  expect(kill.mock.calls).toEqual([
    [-12345, "SIGTERM"],
    [-12345, 0],
    [-12345, 0]
  ])
})

test("preserves permission errors when sending termination", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw failure("EPERM")
  })
  await expect(stopProcessGroup(12345)).rejects.toMatchObject({ code: "EPERM" })
})

test("preserves unexpected existence probe failures", async () => {
  vi.spyOn(process, "kill")
    .mockImplementationOnce(() => true)
    .mockImplementationOnce(() => {
      throw failure("EINVAL")
    })
  await expect(stopProcessGroup(12345)).rejects.toMatchObject({ code: "EINVAL" })
})
