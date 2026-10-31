import type { TouchEvent as ReactTouchEvent } from "react";
import { dismissedJustNow } from "@/lib/player/overlay-dismiss";

/**
 * Taps on the video for touch screens (the iPad build).
 *
 * - The middle third toggles play/pause.
 * - The left and right thirds show or hide the controls on a single tap.
 * - A double tap on the left or right third seeks back or forward by the
 *   user's seek step and hides the controls. The second tap only counts when
 *   it lands near the first; further taps near it right after keep seeking.
 * - The tap that closes an open menu does nothing else.
 *
 * A single tap on the sides waits DOUBLE_TAP_MS before toggling the controls,
 * so the first half of a double tap never flashes them.
 */

const DOUBLE_TAP_MS = 280;
/** After a double tap, single taps on the same side keep seeking this long. */
const SEEK_CHAIN_MS = 700;
const TAP_SLOP_PX = 12;
/** How far the second tap of a double tap may land from the first. */
const DOUBLE_TAP_RADIUS_PX = 90;

type Zone = "left" | "center" | "right";

export type TouchStageActions = {
  playPause: () => void;
  seek: (side: "back" | "forward") => void;
  /** Shows the controls if hidden, hides them if shown. */
  toggleChrome: (wasVisible: boolean) => void;
  hideChrome: () => void;
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
  let lastTap: { zone: Zone; at: number; x: number; y: number } | null = null;
  let chain: { zone: Zone; until: number; x: number; y: number } | null = null;
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
    if (dismissedJustNow()) {
      cancelSingle();
      lastTap = null;
      chain = null;
      return;
    }

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
    const near = (p: { x: number; y: number }) =>
      Math.hypot(t.clientX - p.x, t.clientY - p.y) <= DOUBLE_TAP_RADIUS_PX;
    const chained = chain && chain.zone === zone && now < chain.until && near(chain);
    const doubled =
      lastTap && lastTap.zone === zone && now - lastTap.at < DOUBLE_TAP_MS && near(lastTap);
    if (chained || doubled) {
      cancelSingle();
      lastTap = null;
      chain = { zone, until: now + SEEK_CHAIN_MS, x: t.clientX, y: t.clientY };
      actions.seek(side);
      actions.hideChrome();
      return;
    }

    chain = null;
    lastTap = { zone, at: now, x: t.clientX, y: t.clientY };
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
