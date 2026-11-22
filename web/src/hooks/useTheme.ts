import { useEffect } from "react";

/**
 * The dashboard only ships a light theme.
 * This hook pins the document to it: it clears any `dark` / `bp6-dark` class that
 * an earlier version may have left behind and marks the root as `light`.
 */
export function useTheme() {
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("dark", "bp6-dark");
    root.classList.add("light");
  }, []);
}
