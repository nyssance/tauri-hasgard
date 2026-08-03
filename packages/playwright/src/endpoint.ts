import { tmpdir } from "node:os"
import { join } from "node:path"

export function endpointPathForPlatform(name: string, platform: NodeJS.Platform, temporaryDirectory: string): string {
  if (platform === "win32") return `\\\\.\\pipe\\${name}`
  return join(temporaryDirectory, `${name}.sock`)
}

export function hasgardEndpointPath(name: string): string {
  return endpointPathForPlatform(name, process.platform, tmpdir())
}
