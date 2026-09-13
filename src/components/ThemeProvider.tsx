"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

const ThemeCtx = createContext<{
  theme: Theme;
  toggle: () => void;
}>({ theme: "dark", toggle: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The site always opens in dark mode. We deliberately do NOT restore a saved
  // preference: every fresh load starts dark, matching the server-rendered
  // <html className="dark"> in layout.tsx, so the first paint is dark with no
  // flash. The user can still switch to light manually with the toggle; that
  // choice lasts for the current visit and resets to dark on the next load,
  // which keeps dark as the guaranteed entry point.
  const [theme, setTheme] = useState<Theme>("dark");

  // Keep <html> in sync whenever the theme changes during the session.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);

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
