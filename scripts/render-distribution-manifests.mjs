import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tag, assetDirectory, outputDirectory] = process.argv.slice(2);
if (!tag || !assetDirectory || !outputDirectory) {
  throw new Error("usage: render-distribution-manifests.mjs <tag> <asset-directory> <output-directory>");
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`invalid release tag: ${tag}`);

const version = tag.slice(1);
const repository = "https://github.com/nyssance/tauri-hasgard";
const release = `${repository}/releases/download/${tag}`;
const asset = target => `tauri-hasgard-${version}-${target}`;
const hash = name => createHash("sha256").update(readFileSync(join(assetDirectory, name))).digest("hex");

const macArm = `${asset("aarch64-apple-darwin")}.tar.gz`;
const macIntel = `${asset("x86_64-apple-darwin")}.tar.gz`;
const winArm = `${asset("aarch64-pc-windows-msvc")}.zip`;
const winIntel = `${asset("x86_64-pc-windows-msvc")}.zip`;

const formula = `class TauriHasgard < Formula
  desc "Native automation and testing bridge for Tauri 2 applications"
  homepage "${repository}"
  version "${version}"
  license "Apache-2.0"

  on_arm do
    url "${release}/${macArm}"
    sha256 "${hash(macArm)}"
  end

  on_intel do
    url "${release}/${macIntel}"
    sha256 "${hash(macIntel)}"
  end

  def install
    bin.install "tauri-hasgard"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/tauri-hasgard --version")
  end
end
`;

const scoop = {
  version,
  description: "Native automation and testing bridge for Tauri 2 applications",
  homepage: repository,
  license: "Apache-2.0",
  architecture: {
    "64bit": { url: `${release}/${winIntel}`, hash: hash(winIntel) },
    arm64: { url: `${release}/${winArm}`, hash: hash(winArm) }
  },
  bin: "tauri-hasgard.exe",
  checkver: { github: repository },
  autoupdate: {
    architecture: {
      "64bit": { url: `${repository}/releases/download/v$version/tauri-hasgard-$version-x86_64-pc-windows-msvc.zip` },
      arm64: { url: `${repository}/releases/download/v$version/tauri-hasgard-$version-aarch64-pc-windows-msvc.zip` }
    }
  }
};

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, "tauri-hasgard.rb"), formula);
writeFileSync(join(outputDirectory, "tauri-hasgard.json"), `${JSON.stringify(scoop, null, 2)}\n`);
