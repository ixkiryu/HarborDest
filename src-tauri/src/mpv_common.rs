//! mpv glue shared by every platform that embeds libmpv: the desktop player
//! (`mpv.rs`) and the iPad player (`mpv_ios.rs`). Keeping one copy means the
//! frontend sees the same commands, property allowlist and event payloads
//! wherever it runs.

use std::ffi::CString;

use libmpv2::events::{Event, PropertyData};
use libmpv2::mpv_node::MpvNode;
use libmpv2::{Format, Mpv};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) fn mpv_argv_command(mpv: &Mpv, argv: &[&str]) -> Result<(), String> {
    let cstrings: Vec<CString> = argv
        .iter()
        .map(|s| CString::new(*s).map_err(|e| format!("cstring: {}", e)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut ptrs: Vec<*const std::os::raw::c_char> = cstrings.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let rc = unsafe { libmpv2_sys::mpv_command(mpv.ctx.as_ptr(), ptrs.as_mut_ptr()) };
    if rc < 0 {
        return Err(format!("mpv_command rc={}", rc));
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MpvProbe {
    pub available: bool,
    pub binary: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

pub(crate) const OBSERVED_PROPS: &[(&str, u64, PropertyKind)] = &[
    ("time-pos", 1, PropertyKind::Double),
    ("duration", 2, PropertyKind::Double),
    ("pause", 3, PropertyKind::Flag),
    ("eof-reached", 4, PropertyKind::Flag),
    ("track-list", 5, PropertyKind::Node),
    ("volume", 6, PropertyKind::Double),
    ("mute", 7, PropertyKind::Flag),
    ("chapter-list", 8, PropertyKind::Node),
    ("sub-delay", 9, PropertyKind::Double),
    ("audio-delay", 10, PropertyKind::Double),
    ("sub-text", 11, PropertyKind::String),
    ("sub-start", 12, PropertyKind::Double),
    ("af", 13, PropertyKind::String),
    ("dwidth", 14, PropertyKind::Int64),
    ("dheight", 15, PropertyKind::Int64),
    ("video-params/gamma", 16, PropertyKind::String),
    ("demuxer-cache-duration", 17, PropertyKind::Double),
    ("paused-for-cache", 18, PropertyKind::Flag),
    ("secondary-sub-text", 19, PropertyKind::String),
    ("path", 20, PropertyKind::String),
    ("audio-device-list", 21, PropertyKind::Node),
    // Native decoded size. `dwidth`/`dheight` are the post-scale display size,
    // so upscaler presets need these to know how much headroom the window has.
    ("width", 22, PropertyKind::Int64),
    ("height", 23, PropertyKind::Int64),
];

#[derive(Clone, Copy)]
pub(crate) enum PropertyKind {
    Double,
    Flag,
    Int64,
    String,
    Node,
}

impl PropertyKind {
    pub(crate) fn fmt(&self) -> Format {
        match self {
            PropertyKind::Double => Format::Double,
            PropertyKind::Flag => Format::Flag,
            PropertyKind::Int64 => Format::Int64,
            PropertyKind::String => Format::String,
            PropertyKind::Node => Format::Node,
        }
    }
}

pub(crate) fn event_to_payload(event: Event) -> Option<Value> {
    match event {
        Event::PropertyChange { name, change, .. } => {
            let data = match change {
                PropertyData::Str(s) => Value::String(s.to_string()),
                PropertyData::OsdStr(s) => Value::String(s.to_string()),
                PropertyData::Flag(b) => Value::Bool(b),
                PropertyData::Int64(i) => json!(i),
                PropertyData::Double(f) => json!(f),
                PropertyData::Node(n) => mpv_node_to_json(n),
            };
            Some(json!({ "event": "property-change", "name": name, "data": data }))
        }
        Event::EndFile(reason) => {
            let reason = match reason {
                0 => "eof",
                2 => "stop",
                3 => "quit",
                4 => "error",
                5 => "redirect",
                _ => "other",
            };
            Some(json!({ "event": "end-file", "reason": reason }))
        }
        Event::FileLoaded => Some(json!({ "event": "file-loaded" })),
        Event::PlaybackRestart => Some(json!({ "event": "playback-restart" })),
        Event::Seek => Some(json!({ "event": "seek" })),
        Event::Shutdown => Some(json!({ "event": "shutdown" })),
        Event::LogMessage {
            prefix,
            level,
            text,
            ..
        } if matches!(level, "fatal" | "error" | "warn") => Some(
            json!({ "event": "log", "prefix": crate::log_privacy::scrub(prefix), "level": level, "text": crate::log_privacy::scrub(text) }),
        ),
        _ => None,
    }
}

pub(crate) fn mpv_node_to_json(node: MpvNode) -> Value {
    match node {
        MpvNode::None => Value::Null,
        MpvNode::String(s) => Value::String(s),
        MpvNode::Flag(b) => Value::Bool(b),
        MpvNode::Int64(i) => json!(i),
        MpvNode::Double(f) => json!(f),
        MpvNode::ArrayIter(it) => Value::Array(it.map(mpv_node_to_json).collect()),
        MpvNode::MapIter(it) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in it {
                obj.insert(k, mpv_node_to_json(v));
            }
            Value::Object(obj)
        }
    }
}

pub(crate) const MPV_ALLOWED_COMMANDS: &[&str] = &[
    "af",
    "vf",
    "seek",
    "stop",
    "frame-step",
    "frame-back-step",
    "loadfile",
    "ao-reload",
    // Writes a line into mpv's log, which is the only log a release build keeps.
    // The player uses it to name the control behind each pause/play so a user's
    // log explains itself.
    "print-text",
];

pub(crate) fn mpv_property_blocked(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let n = n
        .strip_prefix("options/")
        .or_else(|| n.strip_prefix("file-local-options/"))
        .unwrap_or(&n);
    const BLOCKED: &[&str] = &[
        "script",
        "input-",
        "load-scripts",
        "ytdl-raw",
        "screenshot-directory",
        "screenshot-template",
        "sub-add",
        "log-file",
        "terminal",
    ];
    BLOCKED.iter().any(|b| n.starts_with(b))
}

pub(crate) fn value_to_arg(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => {
            if *b {
                "yes".into()
            } else {
                "no".into()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}
