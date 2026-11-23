import { tmpdir } from "node:os"
import { posix } from "node:path"

export function endpointPathForPlatform(name: string, platform: NodeJS.Platform, temporaryDirectory: string): string {
  if (platform === "win32") return `\\\\.\\pipe\\${name}`
  // The path belongs to the named platform, not the one running this code.
  return posix.join(temporaryDirectory, `${name}.sock`)
}

export function hasgardEndpointPath(name: string): string {
  return endpointPathForPlatform(name, process.platform, tmpdir())
}
