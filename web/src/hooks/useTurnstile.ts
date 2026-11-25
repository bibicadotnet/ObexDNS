import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";

export interface UseTurnstileProps {
  /** Turnstile site key from auth configuration */
  siteKey?: string;
  /** Whether Turnstile verification is enabled for the current action */
  enabled?: boolean;
  /** Whether the Turnstile external script has loaded */
  turnstileReady: boolean;
  /** Whether Turnstile is currently required (e.g. only in Step 1) */
  isActive: boolean;
  /** Callback to set parent error message */
  onError?: (msg: string) => void;
  /** Callback to clear parent error message */
  onClearError?: () => void;
}

export interface UseTurnstileReturn {
  turnstileToken: string | null;
  setTurnstileToken: React.Dispatch<React.SetStateAction<string | null>>;
  turnstileStatus: "idle" | "verifying" | "success" | "error";
  turnstileRef: React.RefObject<HTMLDivElement | null>;
  resetTurnstile: () => void;
  hasVisibleWidget: boolean;
}

/** Native width of the "normal" Turnstile widget, in CSS px. */
const TURNSTILE_NATIVE_WIDTH = 300;

/**
 * The Turnstile widget is a fixed 300px wide iframe. On very narrow containers
 * (small phones, narrow cards) it would overflow and push the page sideways, so
 * scale it down visually to fit. Returns a cleanup function.
 */
function fitToContainer(el: HTMLElement): () => void {
  const fit = () => {
    const available = el.clientWidth; // layout width, not affected by our own transform
    const scale =
      available > 0 && available < TURNSTILE_NATIVE_WIDTH
        ? available / TURNSTILE_NATIVE_WIDTH
        : 1;
    el.style.transformOrigin = "top center";
    el.style.transform = scale < 1 ? `scale(${scale})` : "";
  };
  fit();
  if (typeof ResizeObserver === "undefined") {
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      el.style.transform = "";
    };
  }
  const ro = new ResizeObserver(fit);
  ro.observe(el);
  return () => {
    ro.disconnect();
    el.style.transform = "";
  };
}

/**
 * Hook to manage Cloudflare Turnstile widget rendering, token state, and teardown.
 * Prevents redundant re-renders and re-verifications when callbacks or parent state change.
 */
export function useTurnstile({
  siteKey,
  enabled,
  turnstileReady,
  isActive,
  onError,
  onClearError
}: UseTurnstileProps): UseTurnstileReturn {
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileStatus, setTurnstileStatus] = useState<
    "idle" | "verifying" | "success" | "error"
  >("idle");
  const [hasVisibleWidget, setHasVisibleWidget] = useState<boolean>(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  const { t } = useTranslation();

  // Decide whether the widget is actually visible (Managed / Non-interactive /
  // interactive) or hidden (Invisible mode). The wrapper collapses to h-0 while
  // this is false, so it must be generous: only report "hidden" when the widget
  // is positively hidden, and never rely on a single signal.
  // Debug: localStorage.setItem("debugTurnstile", "1") then reload.
  const checkVisibility = useCallback(() => {
    const set = (visible: boolean, reason: string) => {
      try {
        if (window.localStorage.getItem("debugTurnstile")) {
          console.debug("[turnstile] visible =", visible, "-", reason);
        }
      } catch {
        /* ignore */
      }
      setHasVisibleWidget(visible);
    };

    const container = turnstileRef.current;
    if (!container) return set(false, "no container");

    const iframe = container.querySelector("iframe");
    if (iframe) {
      const computed = window.getComputedStyle(iframe);
      if (iframe.style.display === "none" || computed.display === "none") {
        return set(false, "iframe display:none");
      }
      if (iframe.style.visibility === "hidden" || computed.visibility === "hidden") {
        return set(false, "iframe visibility:hidden");
      }
      const rect = iframe.getBoundingClientRect();
      const w = Math.max(rect.width, parseFloat(computed.width) || 0, parseFloat(iframe.style.width) || 0);
      const h = Math.max(rect.height, parseFloat(computed.height) || 0, parseFloat(iframe.style.height) || 0);
      if (w <= 1 && h <= 1) return set(false, `iframe ${w}x${h}`);
      return set(true, `iframe ${w}x${h}`);
    }

    // No <iframe> in the light DOM (it can sit inside a shadow root): fall back
    // to the size of the container's own children.
    const hasContent = Array.from(container.children).some((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    });
    return set(hasContent, "no iframe, children size");
  }, []);

  // Store callbacks and t in refs so their identity changes never trigger widget re-mounts
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onClearErrorRef = useRef(onClearError);
  onClearErrorRef.current = onClearError;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    // If not active, or not enabled, or missing siteKey:
    // Teardown any existing widget and reset state.
    if (!isActive || !enabled || !siteKey) {
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch (e) {
          console.error("Turnstile remove error:", e);
        }
        widgetIdRef.current = null;
      }
      setTurnstileToken(null);
      setTurnstileStatus("idle");
      setHasVisibleWidget(false);
      return;
    }

    // Wait until Turnstile SDK is loaded and container element exists
    if (!(turnstileReady || window.turnstile) || !turnstileRef.current) {
      return;
    }

    // If widget is ALREADY rendered and active, do NOT re-render!
    if (widgetIdRef.current) {
      return;
    }

    let stopFitting: (() => void) | undefined;
    let stopObserving: (() => void) | undefined;

    try {
      setTurnstileStatus("verifying");
      turnstileRef.current.innerHTML = "";
      const widgetId = window.turnstile.render(turnstileRef.current, {
        sitekey: siteKey,
        callback: (token: string) => {
          setTurnstileToken(token);
          setTurnstileStatus("success");
          onClearErrorRef.current?.();
          checkVisibility();
        },
        "expired-callback": () => {
          setTurnstileToken(null);
          setTurnstileStatus("idle");
        },
        "error-callback": (err: unknown) => {
          console.error("Turnstile error:", err);
          setTurnstileStatus("error");
          onErrorRef.current?.(
            tRef.current(
              "auth.turnstileError",
              "Verification service failed to load. Please reload and try again."
            )
          );
          setTurnstileToken(null);
        },
        "before-interactive-callback": () => {
          setHasVisibleWidget(true);
        },
        "after-interactive-callback": () => {
          checkVisibility();
        }
      });
      widgetIdRef.current = widgetId;
      checkVisibility();
      stopFitting = fitToContainer(turnstileRef.current);

      // Watch the container for the iframe appearing / being resized so the
      // wrapper can be revealed (Managed / Non-interactive modes never fire
      // before-interactive-callback). Must be attached HERE, once the container
      // exists: it is only rendered after the auth config has loaded.
      stopObserving = (() => {
        const el = turnstileRef.current;
        if (!el) return undefined;
        const observer = new MutationObserver(() => checkVisibility());
        observer.observe(el, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class", "width", "height"]
        });
        // Safety net: the iframe may already exist, or get its size late.
        const retries = [100, 400, 1000, 2500].map((ms) =>
          window.setTimeout(checkVisibility, ms)
        );
        return () => {
          retries.forEach((id) => window.clearTimeout(id));
          observer.disconnect();
        };
      })();
    } catch (e) {
      console.error("Turnstile render error:", e);
      setTurnstileStatus("error");
    }

    return () => {
      stopFitting?.();
      stopObserving?.();
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch (e) {
          console.error("Turnstile cleanup error:", e);
        }
        widgetIdRef.current = null;
      }
      setHasVisibleWidget(false);
    };
  }, [isActive, enabled, siteKey, turnstileReady, checkVisibility]);

  const resetTurnstile = useCallback(() => {
    if (window.turnstile && widgetIdRef.current) {
      try {
        window.turnstile.reset(widgetIdRef.current);
      } catch (e) {
        console.error("Turnstile reset error:", e);
      }
    }
    setTurnstileToken(null);
    setTurnstileStatus("idle");
    setHasVisibleWidget(false);
  }, []);

  return {
    turnstileToken,
    setTurnstileToken,
    turnstileStatus,
    turnstileRef,
    resetTurnstile,
    hasVisibleWidget
  };
}
