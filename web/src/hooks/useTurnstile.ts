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

  // Helper to dynamically check if the Turnstile iframe/container is actually visible
  const checkVisibility = useCallback(() => {
    const container = turnstileRef.current;
    if (!container) {
      setHasVisibleWidget(false);
      return;
    }

    const iframe = container.querySelector("iframe");
    if (!iframe) {
      setHasVisibleWidget(false);
      return;
    }

    const styleDisplay = iframe.style.display;
    const styleVisibility = iframe.style.visibility;
    if (styleDisplay === "none" || styleVisibility === "hidden") {
      setHasVisibleWidget(false);
      return;
    }

    const styleWidth = iframe.style.width;
    const styleHeight = iframe.style.height;
    if (
      (styleWidth === "0px" || styleWidth === "0") &&
      (styleHeight === "0px" || styleHeight === "0")
    ) {
      setHasVisibleWidget(false);
      return;
    }

    const computed = window.getComputedStyle(iframe);
    if (computed.display === "none" || computed.visibility === "hidden") {
      setHasVisibleWidget(false);
      return;
    }

    const rect = iframe.getBoundingClientRect();
    const w = parseFloat(computed.width) || rect.width || parseFloat(styleWidth) || 0;
    const h = parseFloat(computed.height) || rect.height || parseFloat(styleHeight) || 0;

    if (w <= 1 && h <= 1) {
      setHasVisibleWidget(false);
      return;
    }

    setHasVisibleWidget(true);
  }, []);

  // Observe DOM changes inside turnstile container to detect when widget becomes visible or hidden
  useEffect(() => {
    const el = turnstileRef.current;
    if (!el) return;

    const observer = new MutationObserver(() => {
      checkVisibility();
    });

    observer.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "width", "height"]
    });

    return () => {
      observer.disconnect();
    };
  }, [checkVisibility]);

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
      checkVisibility();
    } catch (e) {
      console.error("Turnstile render error:", e);
      setTurnstileStatus("error");
    }

    return () => {
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
