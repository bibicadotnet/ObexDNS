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
 * Calls `onChange` whenever a child of `el` is added or changes size.
 * Changes inside Turnstile's closed shadow root are invisible to a
 * MutationObserver, but the size of its host element is not. Returns a
 * cleanup function.
 */
function watchChildren(el: HTMLElement, onChange: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const resizeObserver = new ResizeObserver(onChange);
  const observeChildren = () => {
    Array.from(el.children).forEach((child) => resizeObserver.observe(child));
    onChange();
  };
  const mutationObserver = new MutationObserver(observeChildren);
  mutationObserver.observe(el, { childList: true });
  observeChildren();
  return () => {
    mutationObserver.disconnect();
    resizeObserver.disconnect();
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

  // Is the widget actually shown (Managed / Non-interactive / interactive) or
  // hidden (Invisible)? Turnstile draws its iframe inside a closed shadow root,
  // so it cannot be queried; look at the size of the container's direct
  // children instead (the shadow host takes the iframe's size).
  const checkVisibility = useCallback(() => {
    const container = turnstileRef.current;
    const visible =
      !!container &&
      Array.from(container.children).some((child) => {
        const style = window.getComputedStyle(child);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = child.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      });
    setHasVisibleWidget(visible);
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
    let stopWatching: (() => void) | undefined;

    try {
      setTurnstileStatus("verifying");
      turnstileRef.current.innerHTML = "";
      const widgetId = window.turnstile.render(turnstileRef.current, {
        sitekey: siteKey,
        callback: (token: string) => {
          setTurnstileToken(token);
          setTurnstileStatus("success");
          onClearErrorRef.current?.();
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
      stopFitting = fitToContainer(turnstileRef.current);
      stopWatching = watchChildren(turnstileRef.current, checkVisibility);
    } catch (e) {
      console.error("Turnstile render error:", e);
      setTurnstileStatus("error");
    }

    return () => {
      stopFitting?.();
      stopWatching?.();
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
