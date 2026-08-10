//! Discovers and tails Claude Code transcript files under the watch root
//! (default `~/.claude/projects`), parses appended lines, and forwards them
//! to the aggregator thread.

use crate::parser::{parse_line, Parsed};
use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, SystemTime};

/// Identity of one transcript stream: a main session or one of its subagents.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SourceMeta {
    /// Session UUID, or "{session}:{agent}" for a subagent file.
    pub id: String,
    pub session_id: String,
    pub agent_id: Option<String>,
    /// Encoded project dir name (last path component under the root).
    pub project_dir: String,
}

pub struct Batch {
    pub source: SourceMeta,
    pub lines: Vec<Parsed>,
    /// True during startup seeding: count tokens, but don't animate chops.
    pub seeded: bool,
    /// File mtime, used as last-activity during seeding.
    pub mtime: Option<SystemTime>,
}

struct TailState {
    offset: u64,
    partial: Vec<u8>,
}

const SEED_HORIZON: Duration = Duration::from_secs(6 * 3600);
const RESCAN_EVERY: u32 = 15; // poll ticks (2s each) between full rescans

pub fn watch_root() -> PathBuf {
    if let Ok(root) = std::env::var("TOKENFOREST_ROOT") {
        return PathBuf::from(root);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
}

/// Blocking loop; run on a dedicated thread.
pub fn run(root: PathBuf, out: Sender<Batch>) {
    let mut tails: HashMap<PathBuf, TailState> = HashMap::new();

    // Startup seeding: old files skip to EOF, recent ones are parsed fully so
    // the current 5h block starts with correct totals and a warm dedupe set.
    for path in collect_jsonl(&root) {
        let mtime = path.metadata().and_then(|m| m.modified()).ok();
        let recent = mtime
            .and_then(|t| t.elapsed().ok())
            .map(|age| age < SEED_HORIZON)
            .unwrap_or(false);
        if recent {
            if let Some(batch) = tail_file(&root, &path, &mut tails, true) {
                let _ = out.send(batch);
            }
        } else if let Ok(meta) = path.metadata() {
            tails.insert(
                path,
                TailState {
                    offset: meta.len(),
                    partial: Vec::new(),
                },
            );
        }
    }

    // FS events (debounced) + a 2s poll tick as safety net.
    let (fs_tx, fs_rx) = mpsc::channel();
    let mut debouncer = new_debouncer(Duration::from_millis(300), fs_tx).ok();
    if let Some(d) = debouncer.as_mut() {
        let _ = d.watcher().watch(&root, RecursiveMode::Recursive);
    }

    let mut ticks: u32 = 0;
    loop {
        let mut touched: Vec<PathBuf> = Vec::new();
        match fs_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(events)) => {
                touched.extend(
                    events
                        .into_iter()
                        .map(|e| e.path)
                        .filter(|p| p.extension().is_some_and(|e| e == "jsonl")),
                );
                // Drain anything else already queued.
                while let Ok(Ok(more)) = fs_rx.try_recv() {
                    touched.extend(
                        more.into_iter()
                            .map(|e| e.path)
                            .filter(|p| p.extension().is_some_and(|e| e == "jsonl")),
                    );
                }
            }
            Ok(Err(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                ticks += 1;
                // Poll known files for growth (covers missed events).
                for (path, tail) in tails.iter() {
                    if let Ok(meta) = path.metadata() {
                        if meta.len() != tail.offset {
                            touched.push(path.clone());
                        }
                    }
                }
                // Periodic rescan to discover files created without an event.
                if ticks % RESCAN_EVERY == 0 {
                    for path in collect_jsonl(&root) {
                        if !tails.contains_key(&path) {
                            touched.push(path);
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }

        touched.sort();
        touched.dedup();
        for path in touched {
            if let Some(batch) = tail_file(&root, &path, &mut tails, false) {
                if out.send(batch).is_err() {
                    return;
                }
            }
        }
    }
}

/// Read newly appended bytes of `path`, parse complete lines, keep the
/// trailing fragment for next time.
fn tail_file(
    root: &Path,
    path: &Path,
    tails: &mut HashMap<PathBuf, TailState>,
    seeded: bool,
) -> Option<Batch> {
    let source = source_for_path(root, path)?;
    let meta = path.metadata().ok()?;
    let tail = tails.entry(path.to_path_buf()).or_insert(TailState {
        offset: 0,
        partial: Vec::new(),
    });

    if meta.len() < tail.offset {
        // File rewritten (session resume / compaction): restart from zero.
        // The message-id dedupe set prevents double counting.
        tail.offset = 0;
        tail.partial.clear();
    }
    if meta.len() == tail.offset {
        return None;
    }

    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(tail.offset)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    tail.offset += buf.len() as u64;

    tail.partial.extend_from_slice(&buf);
    let mut lines = Vec::new();
    while let Some(nl) = tail.partial.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = tail.partial.drain(..=nl).collect();
        if let Ok(s) = std::str::from_utf8(&line[..line.len() - 1]) {
            let s = s.trim();
            if !s.is_empty() {
                lines.push(parse_line(s));
            }
        }
    }
    if lines.is_empty() {
        return None;
    }

    Some(Batch {
        source,
        lines,
        seeded,
        mtime: meta.modified().ok(),
    })
}

/// Map a transcript path to its source identity.
/// `root/<proj>/<session>.jsonl` → session
/// `root/<proj>/<session>/subagents/agent-<id>.jsonl` → session:agent
fn source_for_path(root: &Path, path: &Path) -> Option<SourceMeta> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<&str> = rel.iter().filter_map(|c| c.to_str()).collect();
    let stem = path.file_stem()?.to_str()?.to_string();
    match parts.as_slice() {
        [proj, _file] => Some(SourceMeta {
            id: stem.clone(),
            session_id: stem,
            agent_id: None,
            project_dir: proj.to_string(),
        }),
        [proj, session, "subagents", _file] => {
            let agent = stem.strip_prefix("agent-").unwrap_or(&stem).to_string();
            Some(SourceMeta {
                id: format!("{session}:{agent}"),
                session_id: session.to_string(),
                agent_id: Some(agent),
                project_dir: proj.to_string(),
            })
        }
        _ => None,
    }
}

fn collect_jsonl(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out
}

fn walk(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, depth + 1, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_identity() {
        let root = Path::new("/root");
        let s = source_for_path(root, Path::new("/root/-proj-a/abc-123.jsonl")).unwrap();
        assert_eq!(s.id, "abc-123");
        assert_eq!(s.agent_id, None);
        assert_eq!(s.project_dir, "-proj-a");

        let a = source_for_path(
            root,
            Path::new("/root/-proj-a/abc-123/subagents/agent-xyz.jsonl"),
        )
        .unwrap();
        assert_eq!(a.id, "abc-123:xyz");
        assert_eq!(a.session_id, "abc-123");
        assert_eq!(a.agent_id.as_deref(), Some("xyz"));

        // Non-transcript nesting (e.g. memory/) doesn't match either shape.
        assert!(source_for_path(root, Path::new("/root/-proj-a/memory/notes.jsonl")).is_none());
        assert!(source_for_path(root, Path::new("/elsewhere/x.jsonl")).is_none());
    }
}
