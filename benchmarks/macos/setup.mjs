import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const [vendorArgument, workArgument] = process.argv.slice(2)
if (!vendorArgument || !workArgument) throw new Error("Usage: bun benchmarks/macos/setup.mjs VENDOR_ROOT WORK_DIR")
if (process.platform !== "darwin") throw new Error("This benchmark requires macOS")
const vendor = resolve(vendorArgument)
const work = resolve(workArgument)
const root = fileURLToPath(new URL("../../", import.meta.url))
await mkdir(work, { recursive: true })
const versions = {
  hasgardStatus: (await command("git", ["status", "--porcelain"])).trim(),
  hasgard: (await command("git", ["rev-parse", "HEAD"])).trim(),
  hasgardTrackedDiffSha256: createHash("sha256")
    .update(await command("git", ["diff", "HEAD"]))
    .digest("hex")
}
// Include newly added implementation files as well as tracked changes. A git
// diff alone omits untracked native helpers and process supervisors.
const sourcePaths = (await command("git", ["ls-files", "--cached", "--others", "--exclude-standard"]))
  .trim()
  .split("\n")
  .filter(
    path => /\.(rs|toml|json|mjs|js|ts|html|css|lock)$/.test(path) && !path.startsWith("benchmarks/macos/results/")
  )
  .sort()
versions.hasgardSourceFiles = await Promise.all(
  sourcePaths.map(async path => ({
    path,
    sha256: createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex")
  }))
)
versions.hasgardSourcesSha256 = createHash("sha256").update(JSON.stringify(versions.hasgardSourceFiles)).digest("hex")
for (const name of ["tauri-pilot", "tauri-playwright"]) {
  const source = join(vendor, name)
  const revision = await command("git", ["-C", source, "rev-parse", "HEAD"])
  const status = await command("git", ["-C", source, "status", "--porcelain"])
  if (status.trim()) throw new Error(`${name} has local changes; record or isolate them before benchmarking`)
  versions[name] = revision.trim()
  await cp(source, join(work, "vendor", name), {
    recursive: true,
    filter: path =>
      ![".git", "node_modules", "target", "dist"].some(part => relative(source, path).split("/").includes(part))
  })
}
await command("bun", ["run", "build"], join(root, "examples/fixture-app"), true)
const app = join(work, "app")
await mkdir(join(app, "src"), { recursive: true })
await mkdir(join(app, "capabilities"), { recursive: true })
await mkdir(join(app, "icons"), { recursive: true })
await cp(join(root, "examples/fixture-app/src-tauri/icons/icon.png"), join(app, "icons/icon.png"))
const manifest = `[package]
name = "hasgard-comparison-fixture"
version = "0.1.0"
edition = "2024"
[workspace]
[features]
hasgard = ["dep:tauri-plugin-hasgard"]
pilot = ["dep:tauri-plugin-pilot"]
playwright = ["dep:tauri-plugin-playwright"]
[dependencies]
tauri = { version = "2", features = ["unstable"] }
tauri-plugin-hasgard = { path = ${JSON.stringify(join(root, "crates/tauri-plugin-hasgard"))}, optional = true }
tauri-plugin-pilot = { path = ${JSON.stringify(join(work, "vendor/tauri-pilot/crates/tauri-plugin-pilot"))}, optional = true }
tauri-plugin-playwright = { path = ${JSON.stringify(join(work, "vendor/tauri-playwright/packages/plugin"))}, optional = true }
objc2 = "0.6"
tokio = { version = "1", features = ["sync"] }
[build-dependencies]
tauri-build = "2"
`
await writeFile(join(app, "Cargo.toml"), manifest)
await cp(join(root, "Cargo.lock"), join(app, "Cargo.lock"))
await writeFile(join(app, "build.rs"), "fn main() { tauri_build::build() }\n")
await writeFile(
  join(app, "src/main.rs"),
  `use tauri::Manager;
#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("settings").ok_or("missing settings")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
async fn benchmark_focus(app: tauri::AppHandle) -> Result<bool, String> {
    let window = app.get_webview_window("main").ok_or("missing main window")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            window.show().map_err(|e| e.to_string())?;
            let native = window.ns_window().map_err(|e| e.to_string())?;
            if native.is_null() { return Err("null native window".to_owned()); }
            // SAFETY: AppKit activation and key-window checks run on the main thread.
            let focused = unsafe {
                let application: *mut objc2::runtime::AnyObject = objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
                let _: () = objc2::msg_send![application, activateIgnoringOtherApps: true];
                window.set_focus().map_err(|e| e.to_string())?;
                let active: bool = objc2::msg_send![application, isActive];
                let key: bool = objc2::msg_send![native.cast::<objc2::runtime::AnyObject>(), isKeyWindow];
                active && key
            };
            Ok(focused)
        })();
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn benchmark_window_id(app: tauri::AppHandle) -> Result<u32, String> {
    let window = app.get_webview_window("main").ok_or("missing main window")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let native = window.ns_window().map_err(|e| e.to_string())?;
            if native.is_null() { return Err("null native window".to_owned()); }
            // SAFETY: Tauri owns this NSWindow; it is read on the AppKit main thread.
            let number: isize = unsafe { objc2::msg_send![native.cast::<objc2::runtime::AnyObject>(), windowNumber] };
            u32::try_from(number).map_err(|e| e.to_string())
        })();
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}
fn main() {
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![open_settings, benchmark_window_id, benchmark_focus]);
    #[cfg(feature = "hasgard")]
    let builder = builder.plugin(tauri_plugin_hasgard::init());
    #[cfg(feature = "pilot")]
    let builder = builder.plugin(tauri_plugin_pilot::init());
    #[cfg(feature = "playwright")]
    let builder = builder.plugin(tauri_plugin_playwright::init_with_config(
        tauri_plugin_playwright::PluginConfig::new().socket_path(std::env::var("BENCH_SOCKET").expect("BENCH_SOCKET"))));
    builder.run(tauri::generate_context!()).expect("benchmark application");
}
`
)
const config = JSON.parse(await readFile(join(root, "examples/fixture-app/src-tauri/tauri.conf.json"), "utf8"))
config.identifier = "dev.nyssance.hasgard-comparison"
config.build = { frontendDist: join(root, "examples/fixture-app/dist") }
await writeFile(join(app, "tauri.conf.json"), JSON.stringify(config, null, 2))
const binaries = {}
for (const [tool, permission] of [
  ["hasgard", "hasgard:default"],
  ["pilot", "pilot:default"],
  ["playwright", "playwright:default"]
]) {
  await writeFile(
    join(app, "capabilities/default.json"),
    JSON.stringify({ identifier: "default", windows: ["main", "settings"], permissions: ["core:default", permission] })
  )
  await command(
    "cargo",
    ["build", "--manifest-path", join(app, "Cargo.toml"), "--target-dir", join(app, "target"), "--features", tool],
    root,
    true
  )
  const binary = join(work, `fixture-${tool}`)
  await cp(join(app, "target/debug/hasgard-comparison-fixture"), binary)
  binaries[tool] = binary
}
await writeFile(
  join(work, "setup.json"),
  JSON.stringify(
    {
      versions,
      binaries,
      root,
      work,
      cargoLockSha256: createHash("sha256")
        .update(await readFile(join(app, "Cargo.lock")))
        .digest("hex")
    },
    null,
    2
  )
)

async function command(program, args, cwd = root, visible = false) {
  const child = spawn(program, args, { cwd, stdio: visible ? "inherit" : ["ignore", "pipe", "pipe"] })
  let output = ""
  let error = ""
  child.stdout?.on("data", chunk => {
    output += chunk
  })
  child.stderr?.on("data", chunk => {
    error += chunk
  })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  if (code !== 0) throw new Error(`${program} exited ${code}: ${error}`)
  return output
}
