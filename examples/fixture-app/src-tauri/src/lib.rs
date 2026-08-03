use tauri::Manager;

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("settings").ok_or_else(|| "Settings window is missing".to_owned())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![open_settings]);

    #[cfg(feature = "hasgard-testing")]
    let builder = builder.plugin(tauri_plugin_hasgard::init());

    builder.run(tauri::generate_context!()).expect("failed to run Hasgard fixture application");
}
