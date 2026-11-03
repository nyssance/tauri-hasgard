use tauri::Manager;

#[cfg(all(target_os = "macos", feature = "hasgard-testing"))]
static SHORTCUT_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[cfg(all(target_os = "macos", feature = "hasgard-testing"))]
#[tauri::command]
fn fixture_shortcut(app: tauri::AppHandle, action: String) -> Result<u32, String> {
    use std::sync::atomic::Ordering;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    match action.as_str() {
        "register" => {
            SHORTCUT_COUNT.store(0, Ordering::SeqCst);
            app.global_shortcut()
                .on_shortcut("Control+Alt+Shift+F12", |_, _, event| {
                    if event.state == ShortcutState::Pressed {
                        SHORTCUT_COUNT.fetch_add(1, Ordering::SeqCst);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        "unregister" => app.global_shortcut().unregister("Control+Alt+Shift+F12").map_err(|e| e.to_string())?,
        "count" => (),
        _ => return Err("Unknown shortcut fixture action".to_owned()),
    }
    Ok(SHORTCUT_COUNT.load(Ordering::SeqCst))
}

#[tauri::command]
fn fixture_process_id() -> u32 {
    std::process::id()
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("settings").ok_or_else(|| "Settings window is missing".to_owned())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn run() {
    // The lifecycle harness can recover the native process even if webview
    // readiness fails before the test body runs.
    if let Some(path) = std::env::var_os("HASGARD_LIFECYCLE_PID_FILE") {
        std::fs::write(path, std::process::id().to_string()).expect("write lifecycle PID file");
    }
    let builder = tauri::Builder::default()
        .runtime(tauri_runtime_wry::Wry::default())
        .setup(|app| {
            // Keep fixture windows hidden until they are on the chosen display.
            // Local debugging defaults to a secondary display; CI opts into 0.
            let wanted = match std::env::var("TAURI_HASGARD_DISPLAY") {
                Ok(value) => value,
                Err(std::env::VarError::NotPresent) => "secondary".to_owned(),
                Err(error) => return Err(error.into()),
            };
            let monitors = app.available_monitors()?;
            let primary = app.primary_monitor()?.ok_or("Primary display not found")?;
            let target = if wanted.eq_ignore_ascii_case("secondary") {
                monitors.iter().find(|monitor| monitor.position() != primary.position())
            } else if let Ok(index) = wanted.parse::<usize>() {
                monitors.get(index)
            } else {
                monitors.iter().find(|monitor| monitor.name().is_some_and(|name| name.eq_ignore_ascii_case(&wanted)))
            }
            .ok_or_else(|| format!("Display '{wanted}' not found; fixture will not open on another display"))?;
            for window in app.webview_windows().values() {
                window.set_position(*target.position())?;
            }
            app.get_webview_window("main").ok_or("Main window not found")?.show()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_settings, fixture_process_id]);

    #[cfg(all(target_os = "macos", feature = "hasgard-testing"))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![open_settings, fixture_process_id, fixture_shortcut])
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(feature = "hasgard-testing")]
    let builder = builder.plugin(tauri_plugin_hasgard::init());

    builder.run(tauri::generate_context!()).expect("failed to run Hasgard fixture application");
}
