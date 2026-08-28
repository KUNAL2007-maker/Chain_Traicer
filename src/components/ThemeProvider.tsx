"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "cryptotrace-theme";
// The key this project inherited when it was forked from the FinGuard console.
// Read once so an existing preference carries over instead of silently resetting
// to dark; never written, so the old name disappears on the first toggle.
const LEGACY_STORAGE_KEY = "finguard-theme";

const ThemeCtx = createContext<{
  theme: Theme;
  toggle: () => void;
}>({ theme: "dark", toggle: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");
  // Applying and persisting the theme must wait until the saved value has been
  // read back. Otherwise the first paint's default ("dark") is written to
  // storage before the load runs, and under React's dev double-invoke that
  // stale write clobbers a saved "light" — so a reload silently dropped you
  // back into dark. This guard makes the load the single source of truth on
  // startup; the default and the toggle both still behave exactly as before.
  const [loaded, setLoaded] = useState(false);

  // Load persisted theme
  useEffect(() => {
    const saved =
      (typeof window !== "undefined" &&
        ((localStorage.getItem(STORAGE_KEY) ??
          localStorage.getItem(LEGACY_STORAGE_KEY)) as Theme | null)) ||
      "dark";
    setTheme(saved);
    setLoaded(true);
  }, []);

  // Apply to <html> — but only once the saved value is in, so we never persist
  // the placeholder default over it.
  useEffect(() => {
    if (!loaded) return;
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme, loaded]);

  return (
    <ThemeCtx.Provider
      value={{
        theme,
        toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
      }}
    >
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeCtx);
}
