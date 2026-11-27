import { useEffect } from "react";

/**
 * Forces light theme. No dark mode support.
 */
export function useTheme() {
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("dark", "bp6-dark");
    root.classList.add("light");
  }, []);

  return { theme: "light" as const, setTheme: (_t: string) => {} };
}
