import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      gridTemplateColumns: {
        "24": "repeat(24, minmax(0, 1fr))",
      },
      colors: {
        finguard: {
          bg: "#07090d",
          panel: "#0d1117",
          panel2: "#121821",
          border: "#1f2937",
          muted: "#94a3b8",
          neon: "#22c55e",
          neon2: "#10b981",
          amber: "#f59e0b",
          danger: "#ef4444",
          info: "#38bdf8",
          purple: "#a78bfa",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(34,197,94,0.25)",
        glowRed: "0 0 24px rgba(239,68,68,0.35)",
        glowAmber: "0 0 24px rgba(245,158,11,0.25)",
      },
      keyframes: {
        pulseRed: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(239,68,68,0.6)" },
          "50%": { boxShadow: "0 0 0 12px rgba(239,68,68,0)" },
        },
        pulseAmber: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(245,158,11,0.5)" },
          "50%": { boxShadow: "0 0 0 10px rgba(245,158,11,0)" },
        },
        scan: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        dashmove: {
          to: { strokeDashoffset: "-40" },
        },
        blink: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        pulseRed: "pulseRed 1.6s ease-out infinite",
        pulseAmber: "pulseAmber 2s ease-out infinite",
        scan: "scan 2.4s linear infinite",
        dashmove: "dashmove 1s linear infinite",
        blink: "blink 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
