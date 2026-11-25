//! A page subscribes to an event; the application emits it three times, records which
//! arrived, and exits. Nothing but `tauri` and `tauri-runtime-cef`.
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Emitter, Manager};

static HEARD: Mutex<Vec<u32>> = Mutex::new(Vec::new());
static SUBSCRIBED: AtomicBool = AtomicBool::new(false);
static FINISHED: AtomicBool = AtomicBool::new(false);

fn finish(app: &tauri::AppHandle) {
    if FINISHED.swap(true, Ordering::SeqCst) {
        return;
    }
    let line =
        format!("subscribed={} heard={:?}", SUBSCRIBED.load(Ordering::SeqCst), HEARD.lock().expect("heard").as_slice());
    std::fs::write(std::env::var("PROBE_RESULT").expect("PROBE_RESULT"), line).expect("write result");
    app.exit(0);
}

#[tauri::command]
fn heard(n: u32) {
    HEARD.lock().expect("heard").push(n);
}

/// Called by the page once `listen` has resolved.
#[tauri::command]
fn subscribed(app: tauri::AppHandle) {
    SUBSCRIBED.store(true, Ordering::SeqCst);
    std::thread::spawn(move || {
        for n in 1..=3_u32 {
            std::thread::sleep(Duration::from_millis(500));
            app.emit("ping", n).expect("emit");
        }
        std::thread::sleep(Duration::from_millis(1000));
        finish(&app);
    });
}

#[tauri_runtime_cef::cef_entry_point]
fn main() {
    let runtime = tauri_runtime_cef::Cef::default()
        // The alpha bundler does not package Chromium's Aperitif helper.
        .disable_features(["AperitifHelpers"])
        .root_cache_path(std::env::var("PROBE_PROFILE").expect("PROBE_PROFILE"))
        .secret_storage(tauri_runtime_cef::SecretStorage::Mock);
    tauri::Builder::default()
        .runtime(runtime)
        .setup(|app| {
            let page = std::env::var("PROBE_PAGE").expect("PROBE_PAGE");
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App(page.into())).build()?;
            if std::env::var_os("PROBE_CHILD").is_some() {
                app.get_window("main").ok_or("main missing")?.add_child(
                    tauri::webview::WebviewBuilder::new("child", tauri::WebviewUrl::App("child.html".into()))
                        .position(tauri::LogicalPosition::new(16.0, 120.0))
                        .size(tauri::LogicalSize::new(300.0, 200.0)),
                )?;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(20));
                finish(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![heard, subscribed])
        .run(tauri::generate_context!())
        .expect("probe failed");
}
