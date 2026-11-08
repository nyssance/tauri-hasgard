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
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    let wanted =
        std::env::var("TAURI_HASGARD_DISPLAY").expect("Set TAURI_HASGARD_DISPLAY=secondary (CI may explicitly use 0)");
    let profile = std::env::var("HASGARD_CEF_PROFILE").expect("HASGARD_CEF_PROFILE is required for isolated test runs");
    tauri::Builder::default()
        .runtime(
            tauri_runtime_cef::Cef::default()
                .root_cache_path(profile)
                // This fixture only visits local test pages and deletes its profile.
                // `tauri build --debug` uses custom-protocol, so Auto would ask
                // the system keychain even though debug assertions are enabled.
                .secret_storage(tauri_runtime_cef::SecretStorage::Mock),
        )
        .setup(move |app| {
            let primary = app.primary_monitor()?.ok_or("Primary monitor missing")?;
            let monitors = app.available_monitors()?;
            let found = if wanted == "secondary" {
                monitors.iter().any(|m| m.position() != primary.position())
            } else if let Ok(index) = wanted.parse::<usize>() {
                monitors.get(index).is_some()
            } else {
                monitors.iter().any(|m| m.name().is_some_and(|n| n.eq_ignore_ascii_case(&wanted)))
            };
            if !found {
                return Err("Requested test display unavailable; refusing primary fallback".into());
            }
            Ok(())
        })
        .plugin(tauri_plugin_hasgard::init_cef())
        .invoke_handler(tauri::generate_handler![recreate_guest, close_guest])
        .run(tauri::generate_context!())
        .expect("CEF fixture failed");
}
