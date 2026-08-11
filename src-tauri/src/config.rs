//! Tiny JSON config at ~/.config/tokenforest/config.json (both macOS and
//! Linux — predictable beats platform-idiomatic for a toy).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_BUDGET: u64 = 5_000_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub token_budget: u64,
    /// Last user-dragged panel position (physical px). None until first drag.
    #[serde(default)]
    pub window_x: Option<i32>,
    #[serde(default)]
    pub window_y: Option<i32>,
    /// Last user-chosen panel size (physical px). None until first resize.
    #[serde(default)]
    pub window_w: Option<u32>,
    #[serde(default)]
    pub window_h: Option<u32>,
    /// Dropdown mode: hide on click-away, always on top, skip taskbar.
    /// None = platform default (true on macOS/Windows, false on Linux,
    /// where WMs blur the window during resize/minimize and auto-hide
    /// makes the app feel broken).
    #[serde(default)]
    pub hide_on_blur: Option<bool>,
    /// Read real account usage via the local Claude Code login (default on).
    #[serde(default)]
    pub use_real_usage: Option<bool>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            token_budget: DEFAULT_BUDGET,
            window_x: None,
            window_y: None,
            window_w: None,
            window_h: None,
            hide_on_blur: None,
            use_real_usage: None,
        }
    }
}

/// Load-modify-save, so independent writers (budget, window position) don't
/// clobber each other's fields.
pub fn update<F: FnOnce(&mut Config)>(f: F) {
    let mut cfg = load();
    f(&mut cfg);
    save(&cfg);
}

fn config_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".config")
            .join("tokenforest")
            .join("config.json"),
    )
}

pub fn load() -> Config {
    config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(config: &Config) {
    let Some(path) = config_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(path, json);
    }
}
