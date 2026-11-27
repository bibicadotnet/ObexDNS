import { Icons, IconNames, IconSize } from "@blueprintjs/icons";

let started = false;

function run() {
  if (started) return;
  started = true;
  // Only the 16px set: that is the size every Blueprint `icon="..."` prop in the app uses. The 20px
  // set (~82 kB) stays out of the way and is fetched by Icon's autoLoad if something asks for it
  // (e.g. the icon of the 404 page's NonIdealState). Loading one icon downloads the whole size's chunk
  // with the split-by-size loader, so preloading every name costs one request.
  Icons.load(Object.values(IconNames), IconSize.STANDARD).catch(() => {});
}

/**
 * Warms the Blueprint icon cache so the dashboard does not show empty icon slots on first render.
 * The login page does not need it (Icon loads on demand), so callers invoke it only once a session
 * is likely or confirmed.
 *
 * @param when `idle` waits for the browser to be idle (avoids network contention on mobile);
 *             `now` starts immediately, for when the dashboard is about to render.
 */
export function preloadIcons(when: "idle" | "now" = "idle") {
  if (started || typeof window === "undefined") return;
  if (when === "now") return run();
  if ("requestIdleCallback" in window) {
    (window as any).requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 1200);
  }
}
