// Touch handling for the player on the iPad build.
//
// 1. One-tap controls. When a tap makes the page change (the player shows its
//    controls on any touch), iPadOS treats the tap as a "hover" and drops the
//    click, so buttons such as Skip Intro needed a second tap. A tap that ends
//    on a control inside the player now activates it directly.
//
// 2. Tap to hide. A tap on anything in the player that is not a control
//    (empty space, the shaded area behind the transport, labels) hides the
//    controls when they were showing. The video stage handles its own taps
//    (touch-stage-gestures.ts), so it is left alone here.
//
// Installed once from main.tsx on iOS only.

import { dismissedJustNow } from "@/lib/player/overlay-dismiss";

export const PLAYER_HIDE_CHROME_EVENT = "harbor:player-hide-chrome";

const TAP_SLOP_PX = 10;

const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  "label",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
].join(",");

/** Elements that need the browser's own handling of the touch. */
const NATIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]",
  '[role="slider"]',
  "[data-player-seekbar]",
].join(",");

/** Anything that counts as part of a control for the hide-on-tap rule. */
const INTERACTIVE_SELECTOR = `${CONTROL_SELECTOR},${NATIVE_SELECTOR},[data-dropdown-menu],[role="menu"],[role="listbox"],[role="dialog"]`;

export function installIosPlayerTouch(): void {
  let start: { x: number; y: number; chromeVisible: boolean } | null = null;

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) {
        start = null;
        return;
      }
      const t = e.touches[0];
      start = {
        x: t.clientX,
        y: t.clientY,
        // Read before the player's own touchstart listener shows the controls.
        chromeVisible: document.documentElement.hasAttribute("data-player-chrome-visible"),
      };
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "touchend",
    (e) => {
      const begin = start;
      start = null;
      if (!begin || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      if (Math.abs(t.clientX - begin.x) > TAP_SLOP_PX || Math.abs(t.clientY - begin.y) > TAP_SLOP_PX) {
        return;
      }
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest("[data-harbor-player]")) return;
      if (target.closest("[data-player-click-stage]")) return;
      if (target.closest(NATIVE_SELECTOR)) return;

      const control = target.closest<HTMLElement>(CONTROL_SELECTOR);
      if (control) {
        if (control.matches(":disabled, [aria-disabled='true']")) return;
        // Controls faded out with the transport stay in place; a tap there
        // only brings the controls back, it must not press an unseen button.
        if (!begin.chromeVisible && control.closest(".opacity-0")) {
          e.preventDefault();
          return;
        }
        // Cancel the emulated mouse events so the control does not fire twice.
        e.preventDefault();
        control.click();
        return;
      }

      if (target.closest(INTERACTIVE_SELECTOR)) return;
      // The tap that closed a menu should only close the menu.
      if (dismissedJustNow()) return;
      if (begin.chromeVisible) window.dispatchEvent(new Event(PLAYER_HIDE_CHROME_EVENT));
    },
    { capture: true, passive: false },
  );
}
