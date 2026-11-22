import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Measures the width of the element it is attached to (not the viewport).
 *
 * The dashboard has a 256px sidebar on desktop, so a viewport of 768px leaves
 * only ~512px for the page. Switching table <-> card layouts on the container
 * width keeps tables from ever needing a horizontal scrollbar.
 *
 * Returns a callback ref and the current width in px (0 until first measured).
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>() {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;

    setWidth(Math.round(node.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0].contentRect.width);
      setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return [ref, width] as const;
}
