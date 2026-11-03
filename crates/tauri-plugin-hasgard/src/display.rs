//! Window placement for test runs: `TAURI_HASGARD_DISPLAY` moves every new window onto one
//! display so an automated run does not cover the developer's main screen.
//!
//! The value is `secondary` (the first display that is not the primary one), a display index
//! from 0 in `available_monitors` order, or a display name (case-insensitive). The window is
//! moved by the target display's own scale factor and shrunk to fit inside it, then shown, so
//! an application that creates its windows hidden in test builds never flashes on the primary
//! display. Unset, nothing changes.

pub(crate) const ENV: &str = "TAURI_HASGARD_DISPLAY";

/// One display as placement sees it, in logical points of the desktop coordinate space.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Display {
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub primary: bool,
}

/// The display a `TAURI_HASGARD_DISPLAY` value names.
pub(crate) fn choose<'a>(displays: &'a [Display], wanted: &str) -> Option<&'a Display> {
    if wanted.eq_ignore_ascii_case("secondary") {
        return displays.iter().find(|display| !display.primary);
    }
    if let Ok(index) = wanted.parse::<usize>() {
        return displays.get(index);
    }
    displays.iter().find(|display| display.name.as_deref().is_some_and(|name| name.eq_ignore_ascii_case(wanted)))
}

/// Logical frame `(x, y, width, height)` for a window of `size` on `display`: its top-left
/// corner, shrunk to fit.
pub(crate) fn frame(display: &Display, size: (f64, f64)) -> (f64, f64, f64, f64) {
    (display.x, display.y, size.0.min(display.width), size.1.min(display.height))
}

pub(crate) fn place<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let Some(wanted) = std::env::var(ENV).ok().filter(|value| !value.is_empty()) else { return };
    let primary = window.primary_monitor().ok().flatten().map(|monitor| *monitor.position());
    let displays: Vec<Display> = match window.available_monitors() {
        Ok(monitors) => monitors
            .iter()
            .map(|monitor| {
                // Monitor positions and sizes are physical pixels at that monitor's own scale.
                let scale = monitor.scale_factor();
                let position = monitor.position().to_logical::<f64>(scale);
                let size = monitor.size().to_logical::<f64>(scale);
                Display {
                    name: monitor.name().cloned(),
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                    primary: Some(*monitor.position()) == primary,
                }
            })
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "{ENV}: cannot list displays; window left in place");
            Vec::new()
        }
    };
    if let Some(display) = choose(&displays, &wanted) {
        let scale = window.scale_factor().unwrap_or(1.0);
        let size = window.outer_size().map(|size| size.to_logical::<f64>(scale));
        let size = size.map_or((display.width, display.height), |size| (size.width, size.height));
        let (x, y, width, height) = frame(display, size);
        if let Err(error) = window.set_size(tauri::LogicalSize::new(width, height)) {
            tracing::warn!(%error, "{ENV}: cannot resize window");
        }
        if let Err(error) = window.set_position(tauri::LogicalPosition::new(x, y)) {
            tracing::warn!(%error, "{ENV}: cannot move window");
        }
    } else {
        tracing::warn!(wanted, count = displays.len(), "{ENV}: no such display; window left in place");
    }
    if let Err(error) = window.show() {
        tracing::warn!(%error, "{ENV}: cannot show window");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn displays() -> Vec<Display> {
        vec![
            Display { name: Some("P276MV".into()), x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, primary: true },
            Display {
                name: Some("VX2731-2K-HD".into()),
                x: -1152.0,
                y: 0.0,
                width: 1152.0,
                height: 2048.0,
                primary: false,
            },
        ]
    }

    #[test]
    fn chooses_by_role_index_and_name() {
        let displays = displays();
        assert_eq!(choose(&displays, "secondary"), Some(&displays[1]));
        assert_eq!(choose(&displays, "SECONDARY"), Some(&displays[1]));
        assert_eq!(choose(&displays, "0"), Some(&displays[0]));
        assert_eq!(choose(&displays, "vx2731-2k-hd"), Some(&displays[1]));
        assert_eq!(choose(&displays, "2"), None);
        assert_eq!(choose(&displays, "missing"), None);
        assert_eq!(choose(&displays[..1], "secondary"), None);
    }

    #[test]
    fn frame_stays_inside_the_display() {
        let displays = displays();
        // A 1200-point window on a 1152-point portrait display at the left of a 2x primary.
        assert_eq!(frame(&displays[1], (1200.0, 800.0)), (-1152.0, 0.0, 1152.0, 800.0));
        assert_eq!(frame(&displays[0], (1200.0, 800.0)), (0.0, 0.0, 1200.0, 800.0));
    }
}
