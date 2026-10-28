# 0.6.2

Keep automated runs off the developer's main screen: `TAURI_HASGARD_DISPLAY` places every new window on one display.

- The value is `secondary` (the first display that is not the primary one), a display index from 0, or a display name, case-insensitive.
- The plugin moves each new window by the target display's own scale factor, shrinks it to fit inside that display, and shows it. Applications that create their windows hidden in test builds therefore never flash on the primary display. Unset, windows stay where the application put them.

Requires Tauri 3 with Wry. Tauri 2 applications should remain on the 0.5.x line.
CEF is unsupported. Published to crates.io, npm `latest`, Homebrew and Scoop. macOS supports Apple Silicon only.
