//! iPad playback through libmpv (linked from MPVKit by the Xcode project).
//!
//! The frontend drives this with the same commands and `mpv://event` payloads
//! as the desktop player, so `src/lib/player/mpv.ts` needs no iOS branch. What
//! differs is the surface: mpv renders with gpu-next over MoltenVK into a
//! CAMetalLayer that `ios/HarborVideoSurface.swift` places under the
//! transparent webview, the same "native video behind the page" model macOS
//! and Linux use when the player is embedded.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use libmpv2::events::{Event, EventContext};
use libmpv2::mpv_node::MpvNode;
use libmpv2::Mpv;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::mpv_common::{
    event_to_payload, mpv_argv_command, mpv_property_blocked, value_to_arg, MpvProbe,
    MPV_ALLOWED_COMMANDS, OBSERVED_PROPS,
};

extern "C" {
    // Defined in src-tauri/ios/HarborVideoSurface.swift. Both must run on the
    // main thread; the webview pointer is the WKWebView Tauri hands out.
    fn harbor_ios_video_attach(webview: *mut c_void) -> i64;
    fn harbor_ios_video_set_frame(webview: *mut c_void, x: f64, y: f64, w: f64, h: f64);
    fn harbor_ios_video_detach();
    fn harbor_ios_system_volume() -> f32;
    fn harbor_ios_set_system_volume(value: f32);
}

// System volume sync. mpv plays at 100% and the player's volume is the iPad's
// own: Harbor's slider moves the system volume, and the side buttons move
// Harbor's slider. Both directions reach the frontend as mpv `volume`
// property changes, so the player code is the same as on desktop.

static APP: OnceLock<AppHandle> = OnceLock::new();
/// The player restores its saved volume right after it starts; those writes
/// must not overwrite the iPad's volume, so they are ignored until this time.
static VOLUME_WRITES_FROM: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
const STARTUP_VOLUME_HOLD: Duration = Duration::from_millis(2500);

fn emit_volume(app: &AppHandle, fraction: f32) {
    let percent = (fraction.clamp(0.0, 1.0) * 100.0).round();
    let _ = app.emit(
        "mpv://event",
        json!({ "event": "property-change", "name": "volume", "data": percent }),
    );
}

/// Called by HarborVideoSurface.swift when the system volume changes.
#[no_mangle]
pub extern "C" fn harbor_ios_volume_changed(value: f32) {
    if let Some(app) = APP.get() {
        emit_volume(app, value);
    }
}

fn set_system_volume(app: &AppHandle, value: &Value) {
    let hold = VOLUME_WRITES_FROM.lock().ok().and_then(|g| *g);
    if hold.is_some_and(|until| Instant::now() < until) {
        return;
    }
    let percent = match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    };
    let Some(percent) = percent else { return };
    let fraction = (percent / 100.0).clamp(0.0, 1.0) as f32;
    let _ = app.run_on_main_thread(move || unsafe { harbor_ios_set_system_volume(fraction) });
}

#[derive(Default)]
pub struct MpvState {
    inner: Mutex<Option<Session>>,
}

struct Session {
    mpv: Arc<Mpv>,
}

impl MpvState {
    pub fn new() -> Self {
        Self::default()
    }

    async fn handle(&self) -> Result<Arc<Mpv>, String> {
        self.inner
            .lock()
            .await
            .as_ref()
            .map(|s| s.mpv.clone())
            .ok_or_else(|| "mpv not started".to_string())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvStartArgs {
    pub url: String,
    pub start_at_sec: Option<f64>,
    pub is_live: Option<bool>,
    pub headers: Option<HashMap<String, String>>,
    pub hdr_to_sdr: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvGeometry {
    pub css_left: f64,
    pub css_top: f64,
    pub css_width: f64,
    pub css_height: f64,
}

/// Runs `f` with the main webview's WKWebView on the main thread and waits for it.
fn on_main_webview<R: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(*mut c_void) -> R + Send + 'static,
) -> Result<R, String> {
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview missing".to_string())?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let _ = tx.send(f(platform.inner()));
        })
        .map_err(|e| format!("with_webview: {e}"))?;
    rx.recv_timeout(Duration::from_secs(4))
        .map_err(|_| "main thread did not answer".to_string())
}

#[tauri::command]
pub async fn mpv_probe() -> MpvProbe {
    MpvProbe {
        available: true,
        binary: Some("MPVKit".into()),
        version: None,
        error: None,
    }
}

#[tauri::command]
pub async fn mpv_start(
    app: AppHandle,
    state: State<'_, MpvState>,
    args: MpvStartArgs,
) -> Result<(), String> {
    stop_session(&state).await;
    let _ = APP.set(app.clone());
    if let Ok(mut hold) = VOLUME_WRITES_FROM.lock() {
        *hold = Some(Instant::now() + STARTUP_VOLUME_HOLD);
    }

    let layer = on_main_webview(&app, |wv| unsafe { harbor_ios_video_attach(wv) })?;
    if layer == 0 {
        return Err("could not create the video layer".into());
    }

    let hdr_to_sdr = args.hdr_to_sdr.unwrap_or(true);
    let mpv = Mpv::with_initializer(move |init| {
        init.set_property("wid", layer)?;
        init.set_property("vo", "gpu-next")?;
        init.set_property("gpu-api", "vulkan")?;
        init.set_property("gpu-context", "moltenvk")?;
        init.set_property("hwdec", "videotoolbox")?;
        // The options below follow Nuvio's iOS player (MPVKit + MoltenVK). They
        // are tuning, so an mpv build without one of them still starts.
        // VideoToolbox sessions can be invalidated by the system (Control
        // Center, PiP); keep hardware decoding and let FFmpeg recreate them.
        let _ = init.set_property("hwdec-software-fallback", "300");
        let _ = init.set_property("ao", "audiounit");
        let _ = init.set_property("audio-channels", "auto");
        let _ = init.set_property("audio-fallback-to-null", "yes");
        let _ = init.set_property("vulkan-swap-mode", "fifo");
        let _ = init.set_property("vulkan-queue-count", "1");
        let _ = init.set_property("vulkan-async-compute", "no");
        let _ = init.set_property("vulkan-async-transfer", "no");
        let _ = init.set_property("vulkan-disable-interop", "yes");
        init.set_property("video-rotate", "no")?;
        // The page draws the subtitles over the video (the same path as the
        // embedded desktop player), so mpv must not draw its own copy.
        init.set_property("sub-visibility", "no")?;
        init.set_property("keep-open", "yes")?;
        // Loudness comes from the system volume; see set_system_volume.
        let _ = init.set_property("volume", "100");
        init.set_property("cache", "yes")?;
        init.set_property("cache-on-disk", "no")?;
        // iPads hold far less RAM than the desktops the default 1.5 GB buffer
        // was sized for; iOS kills the app outright if it grows past its limit.
        init.set_property("demuxer-max-bytes", "150MiB")?;
        init.set_property("demuxer-max-back-bytes", "50MiB")?;
        let _ = init.set_property(
            "target-colorspace-hint",
            if hdr_to_sdr { "no" } else { "yes" },
        );
        // MPVKit builds mpv for iOS without Lua, so `osc` (a Lua script option)
        // does not exist there; none of these may stop mpv from starting.
        let _ = init.set_property("input-default-bindings", "no");
        let _ = init.set_property("osc", "no");
        let _ = init.set_property("terminal", "no");
        Ok(())
    })
    .map_err(|e| format!("mpv init: {e}"))?;

    unsafe {
        let level = std::ffi::CString::new("warn").unwrap();
        libmpv2_sys::mpv_request_log_messages(mpv.ctx.as_ptr(), level.as_ptr());
    }
    apply_headers(&mpv, args.headers.as_ref());

    let mpv = Arc::new(mpv);
    let events = EventContext::new(mpv.ctx);
    for (name, id, kind) in OBSERVED_PROPS {
        if let Err(e) = events.observe_property(name, kind.fmt(), *id) {
            eprintln!("[harbor::mpv-ios] observe {name} failed: {e}");
        }
    }
    spawn_event_loop(app.clone(), mpv.clone(), events);

    let start = args.start_at_sec.filter(|s| *s > 0.0).unwrap_or(0.0);
    let _ = mpv.set_property(
        "network-timeout",
        if args.is_live.unwrap_or(false) {
            30
        } else {
            60
        },
    );
    mpv_argv_command(
        &mpv,
        &[
            "loadfile",
            &args.url,
            "replace",
            "0",
            &format!("start={start}"),
        ],
    )?;
    {
        // Show the iPad's volume once the player has finished restoring its own.
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(STARTUP_VOLUME_HOLD);
            emit_volume(&app, unsafe { harbor_ios_system_volume() });
        });
    }

    *state.inner.lock().await = Some(Session { mpv });
    Ok(())
}

fn apply_headers(mpv: &Mpv, headers: Option<&HashMap<String, String>>) {
    let Some(headers) = headers else { return };
    let mut fields = Vec::new();
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("user-agent") {
            let _ = mpv.set_property("user-agent", v.as_str());
        } else {
            fields.push(format!("{k}: {v}"));
        }
    }
    if !fields.is_empty() {
        let _ = mpv.set_property("http-header-fields", fields.join(",").as_str());
    }
}

fn spawn_event_loop(app: AppHandle, mpv: Arc<Mpv>, mut ctx: EventContext) {
    std::thread::spawn(move || {
        // Holding the Arc keeps the handle alive for as long as events can arrive.
        let _keepalive = mpv;
        let mut last_timepos: Option<std::time::Instant> = None;
        loop {
            match ctx.wait_event(0.5) {
                Some(Ok(event)) => {
                    let shutdown = matches!(event, Event::Shutdown);
                    if let Event::PropertyChange { name, .. } = &event {
                        // mpv sits at 100%; the volume the UI shows is the system's.
                        if *name == "volume" {
                            continue;
                        }
                        if *name == "time-pos" {
                            let now = std::time::Instant::now();
                            if last_timepos.is_some_and(|p| now.duration_since(p).as_millis() < 200)
                            {
                                continue;
                            }
                            last_timepos = Some(now);
                        }
                    }
                    if let Some(payload) = event_to_payload(event) {
                        let _ = app.emit("mpv://event", payload);
                    }
                    if shutdown {
                        break;
                    }
                }
                Some(Err(e)) => {
                    eprintln!("[harbor::mpv-ios] event error: {e}");
                    std::thread::sleep(Duration::from_millis(100));
                }
                None => {}
            }
        }
    });
}

#[tauri::command]
pub async fn mpv_command(state: State<'_, MpvState>, cmd: Vec<Value>) -> Result<(), String> {
    let mpv = state.handle().await?;
    let head = cmd
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| "first arg must be string".to_string())?;
    if !MPV_ALLOWED_COMMANDS.contains(&head) {
        return Err(format!("mpv command not allowed: {head}"));
    }
    let tail: Vec<String> = cmd[1..].iter().map(value_to_arg).collect();
    let mut argv: Vec<&str> = vec![head];
    argv.extend(tail.iter().map(String::as_str));
    mpv_argv_command(&mpv, &argv)
}

#[tauri::command]
pub async fn mpv_set_property(
    app: AppHandle,
    state: State<'_, MpvState>,
    name: String,
    value: Value,
) -> Result<(), String> {
    let mpv = state.handle().await?;
    if mpv_property_blocked(&name) {
        return Err(format!("mpv property not allowed: {name}"));
    }
    if name == "volume" {
        set_system_volume(&app, &value);
        return Ok(());
    }
    mpv.set_property(&name, value_to_arg(&value).as_str())
        .map_err(|e| format!("set {name}: {e}"))
}

#[tauri::command]
pub async fn mpv_get_property(state: State<'_, MpvState>, name: String) -> Result<Value, String> {
    let mpv = state.handle().await?;
    if name == "volume" {
        let fraction = unsafe { harbor_ios_system_volume() };
        return Ok(json!((fraction.clamp(0.0, 1.0) * 100.0).round()));
    }
    let s = mpv
        .get_property::<String>(&name)
        .map_err(|e| format!("get {name}: {e}"))?;
    Ok(match s.parse::<f64>() {
        Ok(n) if n.is_finite() => json!(n),
        _ => Value::String(s),
    })
}

#[tauri::command]
pub async fn mpv_get_property_list(
    state: State<'_, MpvState>,
    name: String,
) -> Result<Vec<String>, String> {
    let mpv = state.handle().await?;
    let node: MpvNode = mpv
        .get_property(&name)
        .map_err(|e| format!("get {name}: {e}"))?;
    node.array()
        .and_then(|items| items.map(|item| item.str().map(str::to_string)).collect())
        .ok_or_else(|| format!("{name} is not a list of text"))
}

#[tauri::command]
pub async fn mpv_sub_add(
    state: State<'_, MpvState>,
    url: String,
    lang: Option<String>,
    title: Option<String>,
    select: Option<bool>,
) -> Result<(), String> {
    let mpv = state.handle().await?;
    let flag = if select.unwrap_or(true) {
        "select"
    } else {
        "auto"
    };
    let lang = lang.filter(|s| !s.is_empty()).unwrap_or_default();
    let title = title.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if lang.is_empty() {
            "Subtitle".into()
        } else {
            lang.clone()
        }
    });
    let mut argv = vec!["sub-add", url.as_str(), flag, title.as_str()];
    if !lang.is_empty() {
        argv.push(lang.as_str());
    }
    mpv_argv_command(&mpv, &argv)
}

#[tauri::command]
pub async fn mpv_sub_remove(state: State<'_, MpvState>, id: String) -> Result<(), String> {
    let mpv = state.handle().await?;
    let id = id.trim();
    if id.is_empty() {
        return Err("sub-remove requires a track id".into());
    }
    mpv_argv_command(&mpv, &["sub-remove", id])
}

#[tauri::command]
pub async fn mpv_set_geometry(app: AppHandle, geom: MpvGeometry) -> Result<(), String> {
    on_main_webview(&app, move |wv| unsafe {
        harbor_ios_video_set_frame(
            wv,
            geom.css_left,
            geom.css_top,
            geom.css_width,
            geom.css_height,
        )
    })
}

async fn stop_session(state: &MpvState) {
    if let Some(session) = state.inner.lock().await.take() {
        let _ = session.mpv.command("quit", &[]);
    }
}

#[tauri::command]
pub async fn mpv_stop(app: AppHandle, state: State<'_, MpvState>) -> Result<(), String> {
    stop_session(&state).await;
    let _ = app.run_on_main_thread(|| unsafe { harbor_ios_video_detach() });
    Ok(())
}

/// The desktop player hands its surface back and forth with other windows
/// (picture-in-picture, HDR stage). The iPad has one surface that never
/// moves, so these only report that nothing needed doing.
#[tauri::command]
pub async fn mpv_release_media() -> bool {
    false
}

#[tauri::command]
pub async fn mpv_restore_media_surface() -> bool {
    false
}

#[tauri::command]
pub async fn mpv_audio_devices() -> Vec<Value> {
    Vec::new()
}
