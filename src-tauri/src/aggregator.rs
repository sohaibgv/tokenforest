//! Consumes parsed transcript batches, dedupes usage, tracks per-source
//! activity states and the 5-hour usage block, and emits events to the
//! frontend plus tray icon updates.

use crate::parser::Parsed;
use crate::watcher::{Batch, SourceMeta};
use chrono::{DateTime, Duration as ChronoDuration, Timelike, Utc};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const WORKING_WINDOW: Duration = Duration::from_secs(30);
const SESSION_IDLE: Duration = Duration::from_secs(30 * 60);
const SUBAGENT_IDLE: Duration = Duration::from_secs(90);
const BLOCK_HOURS: i64 = 5;
const DEDUPE_GENERATION_SIZE: usize = 8192;
const WARNING_DENSITY: f64 = 0.2;
/// The tray title shows tokens spent within this rolling window.
const TITLE_WINDOW: Duration = Duration::from_secs(4);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChopEvent {
    pub source_id: String,
    pub session_id: String,
    pub agent_id: Option<String>,
    pub counted: u64,
    pub cache_read: u64,
    pub ts: String,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SourceActivity {
    Working,
    Waiting,
    Idle,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: String,
    pub kind: &'static str, // "session" | "subagent"
    pub state: SourceActivity,
    pub project_dir: String,
    pub last_activity: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    pub start: String,
    pub end: String,
    pub used_counted: u64,
    pub used_cache_read: u64,
    pub budget: u64,
    pub density: f64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub block: Option<BlockInfo>,
    /// Real account usage from the Claude Code login, when readable.
    /// Overrides the manual-budget estimate everywhere it's shown.
    pub real: Option<crate::usage::RealUsage>,
    pub sources: Vec<SourceInfo>,
    pub woodcutters: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LastSignal {
    AssistantEndTurn,
    AssistantToolUse,
    HumanPrompt,
    Other,
}

struct SourceState {
    meta: SourceMeta,
    last_activity: Instant,
    last_activity_utc: DateTime<Utc>,
    last_signal: LastSignal,
}

impl SourceState {
    fn idle_after(&self) -> Duration {
        if self.meta.agent_id.is_some() {
            SUBAGENT_IDLE
        } else {
            SESSION_IDLE
        }
    }

    fn activity(&self, now: Instant) -> SourceActivity {
        let elapsed = now.saturating_duration_since(self.last_activity);
        if elapsed > self.idle_after() {
            SourceActivity::Idle
        } else if self.last_signal == LastSignal::AssistantEndTurn {
            // Turn finished and nothing appended since: waiting for the human.
            SourceActivity::Waiting
        } else if elapsed <= WORKING_WINDOW {
            SourceActivity::Working
        } else {
            // Mid-turn but silent >30s: permission prompt or stall.
            SourceActivity::Waiting
        }
    }
}

struct Block {
    start: DateTime<Utc>,
    used_counted: u64,
    used_cache_read: u64,
}

impl Block {
    fn end(&self) -> DateTime<Utc> {
        self.start + ChronoDuration::hours(BLOCK_HOURS)
    }
}

/// Set by the frontend when a tree falls (wood payout + when), so the tray
/// can celebrate game events, not just token flow.
pub type FellSignal = Arc<Mutex<Option<(Instant, u64)>>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum TrayFrame {
    Idle1,
    Idle2,
    Active1,
    Active2,
    Warning1,
    Warning2,
    Fell1,
    Fell2,
}

fn abbrev(n: u64) -> String {
    if n >= 1_000_000 {
        let m = n as f64 / 1e6;
        if m >= 10.0 {
            format!("{}M", m.round() as u64)
        } else {
            format!("{:.1}M", m)
        }
    } else if n >= 1_000 {
        let k = n as f64 / 1e3;
        if k >= 10.0 {
            format!("{}k", k.round() as u64)
        } else {
            format!("{:.1}k", k)
        }
    } else {
        n.to_string()
    }
}

pub struct Aggregator {
    app: AppHandle,
    budget: Arc<AtomicU64>,
    snapshot: Arc<Mutex<Snapshot>>,
    fell: FellSignal,
    real_usage: crate::usage::SharedUsage,
    dedupe_cur: HashSet<String>,
    dedupe_old: HashSet<String>,
    block: Option<Block>,
    sources: HashMap<String, SourceState>,
    tray_frame: TrayFrame,
    tray_title: String,
    anim_phase: bool,
    /// Live (non-seeded) chops for the rolling tray-title counter.
    recent_chops: VecDeque<(Instant, u64)>,
}

impl Aggregator {
    pub fn new(
        app: AppHandle,
        budget: Arc<AtomicU64>,
        snapshot: Arc<Mutex<Snapshot>>,
        fell: FellSignal,
        real_usage: crate::usage::SharedUsage,
    ) -> Self {
        Self {
            app,
            budget,
            snapshot,
            fell,
            real_usage,
            dedupe_cur: HashSet::new(),
            dedupe_old: HashSet::new(),
            block: None,
            sources: HashMap::new(),
            tray_frame: TrayFrame::Idle1,
            tray_title: String::new(),
            anim_phase: false,
            recent_chops: VecDeque::new(),
        }
    }

    /// Blocking loop; run on a dedicated thread. 500ms cadence so the tray
    /// icon can animate; snapshots still go out at 1Hz.
    pub fn run(mut self, rx: Receiver<Batch>) {
        let mut last_snapshot = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(batch) => {
                    self.handle_batch(batch);
                    // Drain whatever else is queued before ticking.
                    while let Ok(b) = rx.try_recv() {
                        self.handle_batch(b);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let emit = last_snapshot.elapsed() >= Duration::from_secs(1);
            if emit {
                last_snapshot = Instant::now();
            }
            self.tick(emit);
        }
    }

    fn handle_batch(&mut self, batch: Batch) {
        let now = Instant::now();
        let now_utc = Utc::now();
        // During seeding, liveness comes from the file's mtime, not "now" —
        // otherwise every historical session would wake up as Working.
        let (activity_instant, activity_utc) = if batch.seeded {
            let age = batch
                .mtime
                .and_then(|t| t.elapsed().ok())
                .unwrap_or(Duration::from_secs(u64::MAX / 2));
            (
                now.checked_sub(age).unwrap_or(now),
                now_utc - ChronoDuration::from_std(age).unwrap_or(ChronoDuration::zero()),
            )
        } else {
            (now, now_utc)
        };

        // First pass: fold the batch into a final signal and the list of
        // not-yet-seen usage events, without touching self.sources.
        let mut signal: Option<LastSignal> = None;
        let mut usages: Vec<(u64, u64, DateTime<Utc>)> = Vec::new();
        for line in batch.lines {
            match line {
                Parsed::Assistant {
                    message_id,
                    usage,
                    stop_reason,
                    ts,
                } => {
                    signal = Some(match stop_reason.as_deref() {
                        Some("end_turn") => LastSignal::AssistantEndTurn,
                        // Mid-stream lines have no stop_reason yet: still working.
                        _ => LastSignal::AssistantToolUse,
                    });
                    let (Some(id), Some(usage)) = (message_id, usage) else {
                        continue;
                    };
                    if self.dedupe_cur.contains(&id) || self.dedupe_old.contains(&id) {
                        continue;
                    }
                    if self.dedupe_cur.len() >= DEDUPE_GENERATION_SIZE {
                        self.dedupe_old = std::mem::take(&mut self.dedupe_cur);
                    }
                    self.dedupe_cur.insert(id);

                    let event_time = ts
                        .as_deref()
                        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                        .map(|t| t.with_timezone(&Utc))
                        .unwrap_or(now_utc);
                    usages.push((usage.counted(), usage.cache_read_input_tokens, event_time));
                }
                Parsed::HumanPrompt => signal = Some(LastSignal::HumanPrompt),
                Parsed::Activity => {}
            }
        }

        let state = self
            .sources
            .entry(batch.source.id.clone())
            .or_insert(SourceState {
                meta: batch.source.clone(),
                last_activity: activity_instant,
                last_activity_utc: activity_utc,
                last_signal: LastSignal::Other,
            });
        state.last_activity = activity_instant;
        state.last_activity_utc = activity_utc;
        if let Some(signal) = signal {
            state.last_signal = signal;
        }

        for (counted, cache_read, event_time) in usages {
            self.account_usage(event_time, counted, cache_read);
            if !batch.seeded && counted > 0 {
                self.recent_chops.push_back((Instant::now(), counted));
                let _ = self.app.emit(
                    "tf:chop",
                    ChopEvent {
                        source_id: batch.source.id.clone(),
                        session_id: batch.source.session_id.clone(),
                        agent_id: batch.source.agent_id.clone(),
                        counted,
                        cache_read,
                        ts: event_time.to_rfc3339(),
                    },
                );
            }
        }
    }

    fn account_usage(&mut self, t: DateTime<Utc>, counted: u64, cache_read: u64) {
        let needs_new = match &self.block {
            None => true,
            Some(b) => t >= b.end(),
        };
        if needs_new {
            let start = t
                .with_minute(0)
                .and_then(|t| t.with_second(0))
                .and_then(|t| t.with_nanosecond(0))
                .unwrap_or(t);
            let had_block = self.block.is_some();
            self.block = Some(Block {
                start,
                used_counted: 0,
                used_cache_read: 0,
            });
            if had_block {
                let _ = self
                    .app
                    .emit("tf:block-reset", serde_json::json!({ "start": start.to_rfc3339() }));
            }
        }
        if let Some(b) = self.block.as_mut() {
            b.used_counted += counted;
            b.used_cache_read += cache_read;
        }
    }

    fn tick(&mut self, emit_snapshot: bool) {
        let now = Instant::now();

        // Expire the block on wall clock even with no traffic: forest regrows.
        if let Some(b) = &self.block {
            if Utc::now() >= b.end() {
                self.block = None;
                let _ = self
                    .app
                    .emit("tf:block-reset", serde_json::json!({ "start": Utc::now().to_rfc3339() }));
            }
        }

        // Drop idle sources; their woodcutters leave the scene.
        self.sources
            .retain(|_, s| s.activity(now) != SourceActivity::Idle);

        while let Some(&(t, _)) = self.recent_chops.front() {
            if now.duration_since(t) > TITLE_WINDOW {
                self.recent_chops.pop_front();
            } else {
                break;
            }
        }

        let snapshot = self.build_snapshot(now);
        self.update_tray(&snapshot);
        *self.snapshot.lock().unwrap() = snapshot.clone();
        if emit_snapshot {
            let _ = self.app.emit("tf:snapshot", snapshot);
        }
    }

    fn build_snapshot(&self, now: Instant) -> Snapshot {
        let budget = self.budget.load(Ordering::Relaxed).max(1);
        let real = self.real_usage.lock().unwrap().clone();
        let block = self.block.as_ref().map(|b| BlockInfo {
            start: b.start.to_rfc3339(),
            end: b.end().to_rfc3339(),
            used_counted: b.used_counted,
            used_cache_read: b.used_cache_read,
            budget,
            // Real account utilization wins over the manual-budget estimate.
            density: match &real {
                Some(r) => (1.0 - r.five_hour_pct).clamp(0.0, 1.0),
                None => (1.0 - b.used_counted as f64 / budget as f64).clamp(0.0, 1.0),
            },
        });

        let mut sources: Vec<SourceInfo> = self
            .sources
            .values()
            .map(|s| SourceInfo {
                id: s.meta.id.clone(),
                kind: if s.meta.agent_id.is_some() {
                    "subagent"
                } else {
                    "session"
                },
                state: s.activity(now),
                project_dir: s.meta.project_dir.clone(),
                last_activity: s.last_activity_utc.to_rfc3339(),
            })
            .collect();
        sources.sort_by(|a, b| a.id.cmp(&b.id));

        // Sessions show a woodcutter while present (working or resting);
        // subagents only while actually working.
        let woodcutters = sources
            .iter()
            .filter(|s| {
                s.kind == "session" || s.state == SourceActivity::Working
            })
            .count() as u32;

        Snapshot {
            block,
            real,
            sources,
            woodcutters,
        }
    }

    fn update_tray(&mut self, snapshot: &Snapshot) {
        let any_working = snapshot
            .sources
            .iter()
            .any(|s| s.state == SourceActivity::Working);
        let density = snapshot
            .real
            .as_ref()
            .map(|r| (1.0 - r.five_hour_pct).clamp(0.0, 1.0))
            .or_else(|| snapshot.block.as_ref().map(|b| b.density))
            .unwrap_or(1.0);

        // Every state animates on the 500ms tick; fells override everything
        // briefly so the menu bar celebrates alongside the game. Idle sways
        // slowly (every 4th tick) so a resting forest still feels alive.
        self.anim_phase = !self.anim_phase;
        let fell = *self.fell.lock().unwrap();
        let fell_active = fell
            .map(|(t, _)| t.elapsed() < Duration::from_secs(3))
            .unwrap_or(false);
        let next = if fell_active {
            if self.anim_phase {
                TrayFrame::Fell1
            } else {
                TrayFrame::Fell2
            }
        } else if density < WARNING_DENSITY {
            if self.anim_phase {
                TrayFrame::Warning1
            } else {
                TrayFrame::Warning2
            }
        } else if any_working {
            if self.anim_phase {
                TrayFrame::Active1
            } else {
                TrayFrame::Active2
            }
        } else if self.anim_phase {
            TrayFrame::Idle1
        } else {
            TrayFrame::Idle2
        };

        // Title: wood payout right after a fell, else tokens burned recently.
        let burned: u64 = self.recent_chops.iter().map(|&(_, n)| n).sum();
        let title = if let Some((_, wood)) =
            fell.filter(|(t, _)| t.elapsed() < Duration::from_secs(4))
        {
            format!("🪵+{}", abbrev(wood))
        } else if burned > 0 {
            format!("-{}", abbrev(burned))
        } else {
            String::new()
        };

        let Some(tray) = self.app.tray_by_id("main") else {
            return;
        };
        if next != self.tray_frame {
            self.tray_frame = next;
            let icon = match next {
                TrayFrame::Idle1 => crate::icons::tray_idle(),
                TrayFrame::Idle2 => crate::icons::tray_idle2(),
                TrayFrame::Active1 => crate::icons::tray_active(),
                TrayFrame::Active2 => crate::icons::tray_active2(),
                TrayFrame::Warning1 => crate::icons::tray_warning(),
                TrayFrame::Warning2 => crate::icons::tray_warning2(),
                TrayFrame::Fell1 => crate::icons::tray_fell1(),
                TrayFrame::Fell2 => crate::icons::tray_fell2(),
            };
            let _ = tray.set_icon(Some(icon));
        }
        if title != self.tray_title {
            self.tray_title = title.clone();
            let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(agent: Option<&str>) -> SourceMeta {
        SourceMeta {
            id: "s1".into(),
            session_id: "s1".into(),
            agent_id: agent.map(String::from),
            project_dir: "-proj".into(),
        }
    }

    fn state(signal: LastSignal, age: Duration, agent: Option<&str>) -> SourceState {
        let now = Instant::now();
        SourceState {
            meta: meta(agent),
            last_activity: now.checked_sub(age).unwrap(),
            last_activity_utc: Utc::now(),
            last_signal: signal,
        }
    }

    #[test]
    fn state_machine_thresholds() {
        let now = Instant::now();
        // Fresh append mid-turn → working.
        let s = state(LastSignal::AssistantToolUse, Duration::from_secs(5), None);
        assert_eq!(s.activity(now), SourceActivity::Working);
        // end_turn → waiting immediately, even if the append was seconds ago.
        let s = state(LastSignal::AssistantEndTurn, Duration::from_secs(2), None);
        assert_eq!(s.activity(now), SourceActivity::Waiting);
        // Mid-turn but silent 60s → waiting (permission prompt / stall).
        let s = state(LastSignal::AssistantToolUse, Duration::from_secs(60), None);
        assert_eq!(s.activity(now), SourceActivity::Waiting);
        // Session silent > 30min → idle.
        let s = state(LastSignal::AssistantEndTurn, Duration::from_secs(31 * 60), None);
        assert_eq!(s.activity(now), SourceActivity::Idle);
        // Subagent silent > 90s → idle (they never resume).
        let s = state(LastSignal::AssistantToolUse, Duration::from_secs(120), Some("a"));
        assert_eq!(s.activity(now), SourceActivity::Idle);
        // Human prompt just typed → working.
        let s = state(LastSignal::HumanPrompt, Duration::from_secs(1), None);
        assert_eq!(s.activity(now), SourceActivity::Working);
    }

    #[test]
    fn block_boundaries() {
        // Block math without an AppHandle: test the pure parts.
        let start = DateTime::parse_from_rfc3339("2026-08-10T14:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let b = Block {
            start,
            used_counted: 0,
            used_cache_read: 0,
        };
        let inside = DateTime::parse_from_rfc3339("2026-08-10T18:59:59Z").unwrap();
        let outside = DateTime::parse_from_rfc3339("2026-08-10T19:00:00Z").unwrap();
        assert!(inside.with_timezone(&Utc) < b.end());
        assert!(outside.with_timezone(&Utc) >= b.end());
    }
}
