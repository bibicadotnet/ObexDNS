import { useEffect } from "react";

/**
 * Touch devices only (iPhone / iPad / Android): until the person first touches
 * or presses something, undo any scroll that a script causes and drop any
 * focus that a script moves onto an input.
 *
 * Why: third-party widgets such as the Cloudflare Turnstile iframe can grab
 * focus when they finish loading, and Safari then scrolls the page down to the
 * login card and (for an input) pops the keyboard up, even though nobody
 * tapped anything. Safari's scroll restoration after F5 has the same effect.
 *
 * The guard releases itself on the first pointer / touch / key / wheel event,
 * or after `maxMs`, so normal use is never affected. Mouse + keyboard desktops
 * (pointer: fine) are skipped entirely.
 */
export function useSuppressAutoScroll(enabled: boolean, maxMs = 15000): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;

    let released = false;

    const onScroll = () => {
      if (!released && window.scrollY > 0) {
        window.scrollTo(0, 0);
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      if (released) return;
      const el = e.target as HTMLElement | null;
      if (el?.matches?.("input, textarea, select, iframe")) {
        try {
          el.blur();
        } catch {
          /* ignore */
        }
      }
    };

    const interactionEvents = ["pointerdown", "touchstart", "keydown", "wheel"] as const;

    const release = () => {
      if (released) return;
      released = true;
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("focusin", onFocusIn, true);
      interactionEvents.forEach((ev) => window.removeEventListener(ev, release, true));
    };

    const timer = window.setTimeout(release, maxMs);

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("focusin", onFocusIn, true);
    interactionEvents.forEach((ev) =>
      window.addEventListener(ev, release, { capture: true, passive: true })
    );

    // Start from the top, even if the browser tried to restore an old position.
    if (window.scrollY > 0) window.scrollTo(0, 0);

    return release;
  }, [enabled]);
}
