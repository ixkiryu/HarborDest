// Tauri registers its window and webview plugins only on desktop. On the iPad
// every `plugin:window|…` or `plugin:webview|…` call is rejected by the native
// side ("Plugin window not initialized"), and the many places that size, focus
// or fullscreen the window would surface that as an error page. The iPad app
// is a single full-screen window, so answer those calls the way such a window
// would and treat every change request as already satisfied.
//
// Only these two plugins are answered here. Calls to other plugins the iPad
// build lacks keep rejecting: their callers already catch that and fall back,
// and resolving them with a placeholder breaks those fallbacks.
//
// Imported first by main.tsx so it is in place before any module calls in.

import { platform } from "@tauri-apps/plugin-os";

type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
type Internals = { invoke: Invoke };

function windowAnswer(command: string): unknown {
  const scale = window.devicePixelRatio || 1;
  const size = {
    width: Math.round(window.innerWidth * scale),
    height: Math.round(window.innerHeight * scale),
  };
  const position = { x: 0, y: 0 };
  const monitor = {
    name: "iPad",
    size,
    position,
    workArea: { position, size },
    scaleFactor: scale,
  };
  switch (command) {
    case "scale_factor":
      return scale;
    case "inner_size":
    case "outer_size":
    case "webview_size":
      return size;
    case "inner_position":
    case "outer_position":
    case "webview_position":
    case "cursor_position":
      return position;
    case "current_monitor":
    case "primary_monitor":
    case "monitor_from_point":
      return monitor;
    case "available_monitors":
      return [monitor];
    case "is_fullscreen":
    case "is_focused":
    case "is_visible":
    case "is_enabled":
      return true;
    case "is_maximized":
    case "is_minimized":
    case "is_decorated":
    case "is_resizable":
    case "is_maximizable":
    case "is_minimizable":
    case "is_closable":
    case "is_always_on_top":
      return false;
    case "title":
      return document.title;
    case "theme":
      return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    case "get_all_windows":
    case "get_all_webviews":
      return ["main"];
    default:
      return null;
  }
}

function install(): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__;
  if (!internals) return;
  let isIos = false;
  try {
    isIos = platform() === "ios";
  } catch {
    return;
  }
  if (!isIos) return;
  const invoke = internals.invoke.bind(internals);
  internals.invoke = (cmd, args, options) => {
    const match = /^plugin:(window|webview)\|(.+)$/.exec(cmd);
    if (match) return Promise.resolve(windowAnswer(match[2]));
    return invoke(cmd, args, options);
  };
}

install();
