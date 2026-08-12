//! Game save persistence, 3 slots. The payload is opaque JSON — all schema
//! and migration logic lives in the frontend; Rust just stores it safely.
//!
//! Files: ~/.config/tokenforest/save-slot{1,2,3}.json. A pre-slot-era
//! save.json is migrated (renamed) to slot 1 the first time any slot API
//! touches disk, so legacy players keep their progress in slot 1.

use serde::Serialize;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

const SLOT_COUNT: u8 = 3;

fn save_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".config").join("tokenforest"))
}

fn slot_path(slot: u8) -> Option<PathBuf> {
    Some(save_dir()?.join(format!("save-slot{slot}.json")))
}

fn legacy_path() -> Option<PathBuf> {
    Some(save_dir()?.join("save.json"))
}

fn valid_slot(slot: u8) -> bool {
    (1..=SLOT_COUNT).contains(&slot)
}

/// One-time legacy migration: an old single-file save.json becomes slot 1.
/// Rename (not copy) so it can't run twice or leave two divergent copies.
fn migrate_legacy() {
    let (Some(legacy), Some(slot1)) = (legacy_path(), slot_path(1)) else {
        return;
    };
    if legacy.exists() && !slot1.exists() {
        let _ = std::fs::rename(&legacy, &slot1);
    }
}

#[tauri::command]
pub fn load_game(slot: u8) -> Option<String> {
    if !valid_slot(slot) {
        return None;
    }
    migrate_legacy();
    std::fs::read_to_string(slot_path(slot)?).ok()
}

#[tauri::command]
pub fn save_game(slot: u8, json: String) {
    if !valid_slot(slot) {
        return;
    }
    let Some(path) = slot_path(slot) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write-then-rename so a crash mid-write can't corrupt the save.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Raw per-slot payload for the boot-time picker. `json` stays opaque —
/// the frontend parses out whatever summary fields it wants to show;
/// `modified_ms` (file mtime, Unix ms) is the only thing Rust adds, since
/// the frontend can't stat files itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotEntry {
    pub slot: u8,
    pub json: Option<String>,
    pub modified_ms: Option<u64>,
}

#[tauri::command]
pub fn list_slots() -> Vec<SlotEntry> {
    migrate_legacy();
    (1..=SLOT_COUNT)
        .map(|slot| {
            let path = slot_path(slot);
            let json = path
                .as_ref()
                .and_then(|p| std::fs::read_to_string(p).ok());
            let modified_ms = path
                .as_ref()
                .and_then(|p| p.metadata().ok())
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            SlotEntry {
                slot,
                json,
                modified_ms,
            }
        })
        .collect()
}

#[tauri::command]
pub fn delete_slot(slot: u8) {
    if !valid_slot(slot) {
        return;
    }
    if let Some(path) = slot_path(slot) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip() {
        // save_path is home-based; just exercise the write-rename mechanics
        // in a temp dir to keep the test hermetic.
        let dir = std::env::temp_dir().join("tokenforest-save-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("save-slot1.json");
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, "{\"version\":1}").unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"version\":1}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
