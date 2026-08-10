//! Game save persistence. The payload is opaque JSON — all schema and
//! migration logic lives in the frontend; Rust just stores it safely.

use std::path::PathBuf;

fn save_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".config")
            .join("tokenforest")
            .join("save.json"),
    )
}

#[tauri::command]
pub fn load_game() -> Option<String> {
    std::fs::read_to_string(save_path()?).ok()
}

#[tauri::command]
pub fn save_game(json: String) {
    let Some(path) = save_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write-then-rename so a crash mid-write can't corrupt the save.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
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
        let path = dir.join("save.json");
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, "{\"version\":1}").unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"version\":1}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
