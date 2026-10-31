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
// Tauri makes `__TAURI_INTERNALS__.invoke` read-only, so the shim installs
// `__HARBOR_INVOKE_HOOK__`, which the JS API calls instead (see the
// tauri-invoke-hook plugin in vite.config.ts).
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
    case "is_focused":
    case "is_visible":
    case "is_enabled":
      return true;
    // Reported as an ordinary window, as before this shim, when these calls
    // failed and callers fell back to false.
    case "is_fullscreen":
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
      return ["main"];
    case "get_all_webviews":
      return [{ windowLabel: "main", label: "main" }];
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
  watchStartup();
  const invoke = internals.invoke.bind(internals);
  (globalThis as { __HARBOR_INVOKE_HOOK__?: Invoke }).__HARBOR_INVOKE_HOOK__ = (cmd, args, options) => {
    const match = /^plugin:(window|webview)\|(.+)$/.exec(cmd);
    if (match) return Promise.resolve(windowAnswer(match[2]));
    const id = ++callSeq;
    pending.set(id, { cmd, at: performance.now() });
    if (cmd.startsWith("mpv_") && cmd !== "mpv_get_property" && cmd !== "mpv_set_geometry") {
      trace(`→ ${cmd} ${describeArgs(args)}`);
    }
    return invoke(cmd, args, options)
      .catch((error: unknown) => {
        trace(`✗ ${cmd}: ${String(error).slice(0, 300)}`);
        throw error;
      })
      .finally(() => pending.delete(id));
  };
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<Record<string, unknown>>("mpv://event", ({ payload }) => {
      const kind = String(payload.event);
      if (kind === "property-change") {
        const name = String(payload.name);
        if (WATCHED_PROPS.has(name)) trace(`mpv ${name} = ${JSON.stringify(payload.data)?.slice(0, 120)}`);
      } else if (kind === "log") {
        trace(`mpv log ${String(payload.level)} [${String(payload.prefix)}] ${String(payload.text).trim()}`);
      } else {
        trace(`mpv ${kind}${payload.reason ? ` (${String(payload.reason)})` : ""}`);
      }
    }),
  );
  addTraceButton();
}

// Playback trace, shown from a small button in the corner. Temporary while the
// iPad player is being brought up: it is the only way to see what mpv did.
const WATCHED_PROPS = new Set(["duration", "pause", "eof-reached", "dwidth", "dheight", "paused-for-cache", "path"]);
const traceLines: string[] = [];

function trace(line: string): void {
  const t = new Date().toISOString().slice(11, 19);
  traceLines.push(`${t} ${line}`);
  if (traceLines.length > 300) traceLines.shift();
}

/** Shows a URL as host + shortened path so tokens in it never reach a screenshot. */
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    return `${url.protocol}//${url.host}/…/${last.slice(0, 24)}`;
  } catch {
    return value.slice(0, 40);
  }
}

function describeArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {}, (_key, value: unknown) =>
    typeof value === "string" && /^[a-z]+:\/\//i.test(value) ? redactUrl(value) : value,
  );
  return (text ?? "").slice(0, 300);
}

function addTraceButton(): void {
  const add = () => {
    const button = document.createElement("button");
    button.textContent = "LOG";
    button.style.cssText =
      "position:fixed;left:6px;bottom:6px;z-index:2147483647;padding:4px 8px;border-radius:6px;border:0;" +
      "background:rgba(242,163,94,.85);color:#111;font:700 11px system-ui;opacity:.75";
    let panel: HTMLDivElement | null = null;
    button.onclick = () => {
      if (panel) {
        panel.remove();
        panel = null;
        return;
      }
      panel = document.createElement("div");
      panel.style.cssText =
        "position:fixed;left:16px;right:16px;top:16px;bottom:48px;overflow:auto;z-index:2147483646;" +
        "background:rgba(15,15,15,.96);color:#ddd;border-radius:12px;padding:14px;" +
        "font:11px ui-monospace,monospace;white-space:pre-wrap;-webkit-user-select:text;user-select:text";
      const pendingNow = [...pending.values()].map(
        (p) => `${p.cmd} (${Math.round((performance.now() - p.at) / 1000)}s)`,
      );
      panel.textContent =
        `Pending:\n${pendingNow.join("\n") || "(none)"}\n\nErrors:\n${problems.join("\n") || "(none)"}` +
        `\n\nTrace (newest last):\n${traceLines.slice(-120).join("\n") || "(empty)"}`;
      document.body.appendChild(panel);
      panel.scrollTop = panel.scrollHeight;
    };
    document.body.appendChild(button);
  };
  if (document.body) add();
  else window.addEventListener("DOMContentLoaded", add, { once: true });
}

// Startup diagnostics. The iPad has no console to read, so if the splash is
// still up after STARTUP_WATCHDOG_MS, list what startup is still waiting on
// and the errors seen so far, and offer to continue into the app anyway.
const STARTUP_WATCHDOG_MS = 15000;
let callSeq = 0;
const pending = new Map<number, { cmd: string; at: number }>();
const problems: string[] = [];

function note(kind: string, value: unknown): void {
  const text =
    value instanceof Error ? (value.stack ?? value.message) : typeof value === "string" ? value : JSON.stringify(value);
  problems.push(`${kind}: ${String(text).slice(0, 400)}`);
  if (problems.length > 20) problems.shift();
}

function watchStartup(): void {
  window.addEventListener("error", (e) => note("error", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => note("rejection", e.reason));
  const consoleError = console.error.bind(console);
  console.error = (...items: unknown[]) => {
    note("console.error", items.map((i) => (i instanceof Error ? i.message : String(i))).join(" "));
    consoleError(...items);
  };
  window.setTimeout(() => {
    const boot = document.getElementById("harbor-boot");
    if (!boot || !boot.isConnected) return;
    const now = performance.now();
    const waiting = [...pending.values()]
      .map((p) => `${p.cmd} (${Math.round((now - p.at) / 1000)}s)`)
      .slice(0, 15);
    const panel = document.createElement("div");
    panel.style.cssText =
      "position:fixed;left:16px;right:16px;bottom:16px;max-height:45vh;overflow:auto;z-index:2147483647;" +
      "background:rgba(20,20,20,.95);color:#ddd;border-radius:12px;padding:14px;" +
      "font:12px ui-monospace,monospace;white-space:pre-wrap;-webkit-user-select:text;user-select:text";
    const text = document.createElement("div");
    text.textContent =
      `Harbor is still starting after ${STARTUP_WATCHDOG_MS / 1000}s.\n\n` +
      `Waiting on:\n${waiting.length ? waiting.join("\n") : "(no native calls pending)"}\n\n` +
      `Errors:\n${problems.length ? problems.join("\n") : "(none)"}`;
    const button = document.createElement("button");
    button.textContent = "Continue anyway";
    button.style.cssText =
      "margin-top:12px;padding:8px 14px;border-radius:8px;border:0;background:#f2a35e;color:#111;font:600 14px system-ui";
    button.onclick = () => {
      const root = document.getElementById("root");
      if (root) {
        root.removeAttribute("data-startup-hidden");
        root.inert = false;
      }
      document.getElementById("harbor-boot")?.remove();
      document.getElementById("harbor-boot-chrome")?.remove();
      panel.remove();
    };
    panel.append(text, button);
    document.body.appendChild(panel);
  }, STARTUP_WATCHDOG_MS);
}

install();
