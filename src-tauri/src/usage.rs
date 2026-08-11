//! Real account usage, the way Claude Code's /usage shows it: reads the
//! local Claude Code OAuth token (Keychain on macOS, credentials file
//! elsewhere) and polls the usage endpoint for 5-hour / weekly utilization
//! and reset times. Strictly best-effort: any failure leaves the app on the
//! manual-budget estimate. The token never leaves the machine except to
//! Anthropic's API, and is never logged or persisted by us.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const POLL_SECS: u64 = 300;
const RETRY_SECS: u64 = 60;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RealUsage {
    /// 0.0–1.0 of the 5-hour window consumed.
    pub five_hour_pct: f64,
    pub five_hour_resets_at: Option<String>,
    pub weekly_pct: Option<f64>,
    pub weekly_resets_at: Option<String>,
}

pub type SharedUsage = Arc<Mutex<Option<RealUsage>>>;

fn read_oauth_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    let raw: Option<String> = {
        let out = std::process::Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output()
            .ok()?;
        if out.status.success() {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            None
        }
    };
    #[cfg(not(target_os = "macos"))]
    let raw: Option<String> = {
        let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
        std::fs::read_to_string(path).ok()
    };

    #[derive(Deserialize)]
    struct Creds {
        #[serde(rename = "claudeAiOauth")]
        oauth: Option<Oauth>,
    }
    #[derive(Deserialize)]
    struct Oauth {
        #[serde(rename = "accessToken")]
        access_token: Option<String>,
    }
    serde_json::from_str::<Creds>(&raw?)
        .ok()?
        .oauth?
        .access_token
}

/// The endpoint is undocumented and its shape may drift, so parse leniently:
/// find window objects by key and read utilization + reset time from them.
fn parse_usage(body: &serde_json::Value) -> Option<RealUsage> {
    fn window(v: &serde_json::Value, keys: &[&str]) -> Option<(f64, Option<String>)> {
        for key in keys {
            if let Some(w) = v.get(*key) {
                let pct = w
                    .get("utilization")
                    .and_then(|u| u.as_f64())
                    .map(|u| if u > 1.0 { u / 100.0 } else { u })?;
                let resets = w
                    .get("resets_at")
                    .or_else(|| w.get("resetsAt"))
                    .and_then(|r| r.as_str())
                    .map(String::from);
                return Some((pct.clamp(0.0, 1.0), resets));
            }
        }
        None
    }

    let (five_pct, five_resets) = window(body, &["five_hour", "fiveHour"])?;
    let weekly = window(body, &["seven_day", "sevenDay", "seven_day_overall"]);
    Some(RealUsage {
        five_hour_pct: five_pct,
        five_hour_resets_at: five_resets,
        weekly_pct: weekly.as_ref().map(|(p, _)| *p),
        weekly_resets_at: weekly.and_then(|(_, r)| r),
    })
}

fn fetch(token: &str) -> Option<RealUsage> {
    let response = ureq::get(USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(15))
        .call()
        .ok()?;
    let body: serde_json::Value = response.into_json().ok()?;
    parse_usage(&body)
}

/// Blocking poll loop; run on a dedicated thread.
pub fn run(shared: SharedUsage, enabled: Arc<AtomicBool>) {
    loop {
        if enabled.load(Ordering::Relaxed) {
            let usage = read_oauth_token().and_then(|token| fetch(&token));
            let ok = usage.is_some();
            *shared.lock().unwrap() = usage;
            std::thread::sleep(Duration::from_secs(if ok { POLL_SECS } else { RETRY_SECS }));
        } else {
            *shared.lock().unwrap() = None;
            std::thread::sleep(Duration::from_secs(5));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_percent_and_fraction_utilization() {
        let body: serde_json::Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":34,"resets_at":"2026-08-11T19:00:00Z"},
                "seven_day":{"utilization":0.61,"resets_at":"2026-08-14T00:00:00Z"}}"#,
        )
        .unwrap();
        let u = parse_usage(&body).unwrap();
        assert!((u.five_hour_pct - 0.34).abs() < 1e-9);
        assert_eq!(u.five_hour_resets_at.as_deref(), Some("2026-08-11T19:00:00Z"));
        assert!((u.weekly_pct.unwrap() - 0.61).abs() < 1e-9);
    }

    #[test]
    fn missing_five_hour_is_none() {
        let body: serde_json::Value = serde_json::from_str(r#"{"other":{}}"#).unwrap();
        assert!(parse_usage(&body).is_none());
    }
}
