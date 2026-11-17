use tauri::Manager;

fn child(app: &tauri::AppHandle) -> Result<(), String> {
    let host = app.get_window("main").ok_or("main missing")?;
    let url = std::env::var("HASGARD_CEF_GUEST_URL").map_err(|_| "HASGARD_CEF_GUEST_URL is required")?;
    host.add_child(
        tauri::webview::WebviewBuilder::new(
            "guest",
            tauri::WebviewUrl::External(url.parse().map_err(|e| format!("Invalid guest URL: {e}"))?),
        )
        .position(tauri::LogicalPosition::new(16.0, 180.0))
        .size(tauri::LogicalSize::new(760.0, 430.0)),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn recreate_guest(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(view) = app.get_webview("guest") {
        view.close().map_err(|e| e.to_string())?;
    }
    child(&app)
}
#[tauri::command]
fn close_guest(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview("guest").ok_or("guest missing")?.close().map_err(|e| e.to_string())
}
#[tauri::command]
fn ipc_echo(webview: tauri::Webview, value: String) -> Result<String, String> {
    if value == "reject" {
        return Err("fixture rejection".into());
    }
    Ok(format!("{}:{value}", webview.label()))
}
#[tauri::command]
fn set_floating(window: tauri::Window, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(|error| error.to_string())
}
#[tauri::command]
fn quit_fixture(app: tauri::AppHandle) {
    app.exit(0);
}
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    let wanted =
        std::env::var("TAURI_HASGARD_DISPLAY").expect("Set TAURI_HASGARD_DISPLAY=secondary (CI may explicitly use 0)");
    let profile = std::env::var("HASGARD_CEF_PROFILE").expect("HASGARD_CEF_PROFILE is required for isolated test runs");
    let runtime = tauri_runtime_cef::Cef::default()
        // The alpha bundler does not package Chromium's Aperitif helper.
        .disable_features(["AperitifHelpers"])
        .root_cache_path(profile)
        .secret_storage(tauri_runtime_cef::SecretStorage::Mock);
    // Custom SDK validation must explicitly select its matching API version.
    let runtime = match std::env::var("HASGARD_CEF_API_VERSION") {
        Ok(value) => runtime.cef_api_version(value.parse().expect("Invalid HASGARD_CEF_API_VERSION")),
        Err(std::env::VarError::NotPresent) => runtime,
        Err(error) => panic!("Invalid HASGARD_CEF_API_VERSION: {error}"),
    };
    tauri::Builder::default()
        .runtime(runtime)
        .setup(move |app| {
            let primary = app.primary_monitor()?.ok_or("Primary monitor missing")?;
            let monitors = app.available_monitors()?;
            let monitor = if wanted == "secondary" {
                monitors.iter().find(|m| m.position() != primary.position())
            } else if let Ok(index) = wanted.parse::<usize>() {
                monitors.get(index)
            } else {
                monitors.iter().find(|m| m.name().is_some_and(|n| n.eq_ignore_ascii_case(&wanted)))
            }
            .ok_or("Requested test display unavailable; refusing primary fallback")?;
            // Production integration does not reposition windows; the fixture does.
            for window in app.windows().values() {
                window.set_position(*monitor.position())?;
                window.show()?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_hasgard::init_cef())
        .invoke_handler(tauri::generate_handler![recreate_guest, close_guest, ipc_echo, set_floating, quit_fixture])
        .run(tauri::generate_context!())
        .expect("CEF fixture failed");
}
