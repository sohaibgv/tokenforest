mod aggregator;
mod config;
mod icons;
mod parser;
mod save;
mod watcher;

use aggregator::{Aggregator, Snapshot};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_positioner::{Position, WindowExt};

struct AppState {
    snapshot: Arc<Mutex<Snapshot>>,
    budget: Arc<AtomicU64>,
    /// Tray toggles blur the window; ignore blur-hide right after a toggle
    /// so the panel doesn't flicker shut as it opens.
    last_toggle: Mutex<Instant>,
    /// When a blur hides the panel, remember it: if a tray click follows
    /// immediately, that click *caused* the blur and means "close", so the
    /// toggle must not re-open the panel.
    last_blur_hide: Mutex<Option<Instant>>,
    /// Set when *we* position the window, so Moved events from our own
    /// set_position calls aren't mistaken for the user dragging the panel.
    last_prog_move: Mutex<Instant>,
    /// Throttle for persisting drag positions to disk.
    last_pos_save: Mutex<Instant>,
}

#[tauri::command]
fn get_snapshot(state: tauri::State<AppState>) -> Snapshot {
    state.snapshot.lock().unwrap().clone()
}

#[tauri::command]
fn set_budget(tokens: u64, state: tauri::State<AppState>) {
    let tokens = tokens.max(1);
    state.budget.store(tokens, Ordering::Relaxed);
    config::update(|c| c.token_budget = tokens);
}

fn show_panel(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<AppState>();
    *state.last_toggle.lock().unwrap() = Instant::now();
    *state.last_prog_move.lock().unwrap() = Instant::now();
    // Wherever the user last dragged the panel wins; otherwise hang it off
    // the tray icon, or bottom-right before the tray position is known.
    let cfg = config::load();
    if let (Some(w), Some(h)) = (cfg.window_w, cfg.window_h) {
        let _ = window.set_size(tauri::PhysicalSize::new(w, h));
    }
    if let (Some(x), Some(y)) = (cfg.window_x, cfg.window_y) {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    } else if window.move_window(Position::TrayCenter).is_err() {
        let _ = window.move_window(Position::BottomRight);
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn toggle_panel(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<AppState>();
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let hidden_by_this_click = state
            .last_blur_hide
            .lock()
            .unwrap()
            .is_some_and(|t| t.elapsed() < Duration::from_millis(400));
        if hidden_by_this_click {
            return;
        }
        show_panel(app);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = config::load();
    let budget = Arc::new(AtomicU64::new(cfg.token_budget));
    let snapshot = Arc::new(Mutex::new(Snapshot::default()));

    let state = AppState {
        snapshot: snapshot.clone(),
        budget: budget.clone(),
        last_toggle: Mutex::new(Instant::now()),
        last_blur_hide: Mutex::new(None),
        last_prog_move: Mutex::new(Instant::now()),
        last_pos_save: Mutex::new(Instant::now()),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            set_budget,
            save::load_game,
            save::save_game
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open = MenuItemBuilder::with_id("open", "Show / hide panel").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit TokenForest").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;

            TrayIconBuilder::with_id("main")
                .icon(icons::tray_idle())
                .icon_as_template(false)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => toggle_panel(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle());
                    }
                })
                .build(app)?;

            // Show the panel on launch: a tray-only app that starts fully
            // invisible looks broken, especially when the menu bar is full
            // and the tray icon lands behind the notch.
            show_panel(&app.handle().clone());

            // Data pipeline: watcher thread → aggregator thread → tf:* events.
            let (tx, rx) = mpsc::channel();
            let root = watcher::watch_root();
            std::thread::spawn(move || watcher::run(root, tx));
            let agg = Aggregator::new(app.handle().clone(), budget.clone(), snapshot.clone());
            std::thread::spawn(move || agg.run(rx));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(size) = event {
                let state = window.app_handle().state::<AppState>();
                let programmatic = state.last_prog_move.lock().unwrap().elapsed()
                    < Duration::from_millis(1500);
                if !programmatic && window.is_visible().unwrap_or(false) && size.width > 0 {
                    let mut last_save = state.last_pos_save.lock().unwrap();
                    if last_save.elapsed() > Duration::from_millis(300) {
                        *last_save = Instant::now();
                        let (w, h) = (size.width, size.height);
                        config::update(|c| {
                            c.window_w = Some(w);
                            c.window_h = Some(h);
                        });
                    }
                }
            }
            if let WindowEvent::Moved(pos) = event {
                // A Moved not caused by our own positioning is the user
                // dragging the panel: remember where they put it.
                let state = window.app_handle().state::<AppState>();
                let programmatic = state.last_prog_move.lock().unwrap().elapsed()
                    < Duration::from_millis(1500);
                if !programmatic && window.is_visible().unwrap_or(false) {
                    let mut last_save = state.last_pos_save.lock().unwrap();
                    if last_save.elapsed() > Duration::from_millis(300) {
                        *last_save = Instant::now();
                        let (x, y) = (pos.x, pos.y);
                        config::update(|c| {
                            c.window_x = Some(x);
                            c.window_y = Some(y);
                        });
                    }
                }
            }
            if let WindowEvent::Focused(false) = event {
                // Dev escape hatch: keep the panel up for screenshots/tests.
                if std::env::var("TOKENFOREST_NO_AUTOHIDE").is_ok() {
                    return;
                }
                let state = window.app_handle().state::<AppState>();
                let recent_toggle = state.last_toggle.lock().unwrap().elapsed()
                    < Duration::from_millis(300);
                // The throttled Moved handler can miss the tail of a drag;
                // blur means the drag is over, so persist the final spot.
                let programmatic = state.last_prog_move.lock().unwrap().elapsed()
                    < Duration::from_millis(1500);
                if !programmatic {
                    let pos = window.outer_position().ok();
                    let size = window.outer_size().ok();
                    config::update(|c| {
                        if let (Some(p), true) = (pos, c.window_x.is_some()) {
                            c.window_x = Some(p.x);
                            c.window_y = Some(p.y);
                        }
                        if let (Some(s), true) = (size, c.window_w.is_some()) {
                            c.window_w = Some(s.width);
                            c.window_h = Some(s.height);
                        }
                    });
                }
                if !recent_toggle {
                    let _ = window.hide();
                    *state.last_blur_hide.lock().unwrap() = Some(Instant::now());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Finder/`open` on an already-running instance sends Reopen —
            // the user is asking for the app, so bring the panel up.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_panel(_app);
            }
        });
}
