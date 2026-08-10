//! Lenient parsing of Claude Code transcript JSONL lines.
//!
//! The format is undocumented and drifts between versions, so every field is
//! optional and unknown fields are ignored. A line that fails to parse still
//! counts as "activity" for the liveness state machine.

use serde::Deserialize;

#[derive(Deserialize)]
pub struct TranscriptLine {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub timestamp: Option<String>,
    pub message: Option<Msg>,
    pub origin: Option<Origin>,
    #[serde(rename = "promptSource")]
    pub prompt_source: Option<String>,
}

#[derive(Deserialize)]
pub struct Origin {
    pub kind: Option<String>,
}

#[derive(Deserialize)]
pub struct Msg {
    pub id: Option<String>,
    pub stop_reason: Option<String>,
    pub usage: Option<Usage>,
}

#[derive(Deserialize, Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
}

impl Usage {
    /// Tokens counted against the forest budget. Cache reads are excluded:
    /// they dwarf everything else and would drown the signal.
    pub fn counted(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_creation_input_tokens
    }
}

#[derive(Debug)]
pub enum Parsed {
    /// An assistant line. One API message spans several lines that all repeat
    /// the same `message.id` and usage — the aggregator dedupes on it.
    Assistant {
        message_id: Option<String>,
        usage: Option<Usage>,
        stop_reason: Option<String>,
        ts: Option<String>,
    },
    /// A prompt typed by the human (not a tool-result "user" line).
    HumanPrompt,
    /// Anything else, including unparseable lines: only bumps liveness.
    Activity,
}

pub fn parse_line(line: &str) -> Parsed {
    let Ok(l) = serde_json::from_str::<TranscriptLine>(line) else {
        return Parsed::Activity;
    };
    match l.kind.as_deref() {
        Some("assistant") => {
            let m = l.message;
            Parsed::Assistant {
                message_id: m.as_ref().and_then(|m| m.id.clone()),
                usage: m.as_ref().and_then(|m| m.usage),
                stop_reason: m.as_ref().and_then(|m| m.stop_reason.clone()),
                ts: l.timestamp,
            }
        }
        Some("user") => {
            let human = l.origin.as_ref().and_then(|o| o.kind.as_deref()) == Some("human")
                || l.prompt_source.is_some();
            if human {
                Parsed::HumanPrompt
            } else {
                Parsed::Activity
            }
        }
        _ => Parsed::Activity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assistant_usage() {
        let line = r#"{"type":"assistant","sessionId":"s1","timestamp":"2026-08-10T14:20:33.793Z","requestId":"req_1","message":{"id":"msg_1","role":"assistant","stop_reason":"tool_use","usage":{"input_tokens":2,"cache_creation_input_tokens":13993,"cache_read_input_tokens":21297,"output_tokens":915,"server_tool_use":{"web_search_requests":0}}}}"#;
        match parse_line(line) {
            Parsed::Assistant {
                message_id,
                usage,
                stop_reason,
                ts,
            } => {
                assert_eq!(message_id.as_deref(), Some("msg_1"));
                let u = usage.unwrap();
                assert_eq!(u.counted(), 2 + 915 + 13993);
                assert_eq!(u.cache_read_input_tokens, 21297);
                assert_eq!(stop_reason.as_deref(), Some("tool_use"));
                assert!(ts.is_some());
            }
            other => panic!("wrong parse: {other:?}"),
        }
    }

    #[test]
    fn human_prompt_vs_tool_result() {
        let human = r#"{"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"role":"user","content":"hi"}}"#;
        let tool = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#;
        assert!(matches!(parse_line(human), Parsed::HumanPrompt));
        assert!(matches!(parse_line(tool), Parsed::Activity));
    }

    #[test]
    fn garbage_is_activity() {
        assert!(matches!(parse_line("not json {"), Parsed::Activity));
        assert!(matches!(parse_line(r#"{"type":"mode","mode":"plan"}"#), Parsed::Activity));
        assert!(matches!(parse_line(r#"{"unknown":true}"#), Parsed::Activity));
    }
}
