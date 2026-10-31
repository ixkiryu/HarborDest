import type { TouchEvent as ReactTouchEvent } from "react";

/**
 * Taps on the video for touch screens (the iPad build).
 *
 * - The middle third toggles play/pause.
 * - The left and right thirds show or hide the controls on a single tap.
 * - A double tap on the left or right third seeks back or forward by the
 *   user's seek step; further taps on the same side right after keep seeking.
 *
 * A single tap on the sides waits DOUBLE_TAP_MS before toggling the controls,
 * so the first half of a double tap never flashes them.
 */

const DOUBLE_TAP_MS = 280;
/** After a double tap, single taps on the same side keep seeking this long. */
const SEEK_CHAIN_MS = 700;
const TAP_SLOP_PX = 12;

type Zone = "left" | "center" | "right";

export type TouchStageActions = {
  playPause: () => void;
  seek: (side: "back" | "forward") => void;
  /** Shows the controls if hidden, hides them if shown. */
  toggleChrome: (wasVisible: boolean) => void;
};

function zoneOf(x: number, width: number): Zone {
  if (x < width / 3) return "left";
  if (x > (width * 2) / 3) return "right";
  return "center";
}

function chromeShowing(): boolean {
  return document.documentElement.hasAttribute("data-player-chrome-visible");
}

export function createTouchStageGestures(getActions: () => TouchStageActions) {
  let start: { x: number; y: number; chromeWasVisible: boolean } | null = null;
  let lastTap: { zone: Zone; at: number } | null = null;
  let chain: { zone: Zone; until: number } | null = null;
  let pendingSingle: number | null = null;

  const cancelSingle = () => {
    if (pendingSingle != null) window.clearTimeout(pendingSingle);
    pendingSingle = null;
  };

  const onTouchStart = (e: ReactTouchEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.touches.length !== 1) {
      start = null;
      return;
    }
    const t = e.touches[0];
    // Read before the window-level touchstart listener wakes the controls.
    start = { x: t.clientX, y: t.clientY, chromeWasVisible: chromeShowing() };
  };

  const onTouchEnd = (e: ReactTouchEvent<HTMLElement>) => {
    const begin = start;
    start = null;
    if (!begin || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - begin.x) > TAP_SLOP_PX || Math.abs(t.clientY - begin.y) > TAP_SLOP_PX) {
      return;
    }
    // Stop the browser from also sending the emulated mouse click and
    // double-click, which the stage treats as play/pause and fullscreen.
    e.preventDefault();

    const rect = e.currentTarget.getBoundingClientRect();
    const zone = zoneOf(t.clientX - rect.left, rect.width);
    const now = performance.now();
    const actions = getActions();

    if (zone === "center") {
      cancelSingle();
      lastTap = null;
      chain = null;
      actions.playPause();
      return;
    }

    const side = zone === "left" ? "back" : "forward";
    const chained = chain && chain.zone === zone && now < chain.until;
    const doubled = lastTap && lastTap.zone === zone && now - lastTap.at < DOUBLE_TAP_MS;
    if (chained || doubled) {
      cancelSingle();
      lastTap = null;
      chain = { zone, until: now + SEEK_CHAIN_MS };
      actions.seek(side);
      return;
    }

    chain = null;
    lastTap = { zone, at: now };
    cancelSingle();
    const wasVisible = begin.chromeWasVisible;
    pendingSingle = window.setTimeout(() => {
      pendingSingle = null;
      lastTap = null;
      getActions().toggleChrome(wasVisible);
    }, DOUBLE_TAP_MS);
  };

  return { onTouchStart, onTouchEnd, dispose: cancelSingle };
}
