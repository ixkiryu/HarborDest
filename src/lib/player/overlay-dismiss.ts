import { isIos } from "@/lib/platform";

let lastDismiss = 0;

export function noteOverlayDismiss(): void {
  lastDismiss = typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function dismissedJustNow(withinMs = 400): boolean {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return now - lastDismiss < withinMs;
}

export function clearOverlayDismiss(): void {
  lastDismiss = 0;
}

export function watchOutsideMouseDown(handler: (e: MouseEvent) => void): () => void {
  const wrapped = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest?.("[data-dropdown-menu]")) return;
    noteOverlayDismiss();
    handler(e);
  };
  // iPadOS only sends mousedown for taps on elements it considers clickable,
  // and the player stage cancels the emulated mouse events for its own taps,
  // so on touch a tap outside never closed the menu. Pointer events always fire.
  const type = isIos() ? "pointerdown" : "mousedown";
  window.addEventListener(type, wrapped as EventListener);
  return () => window.removeEventListener(type, wrapped as EventListener);
}
