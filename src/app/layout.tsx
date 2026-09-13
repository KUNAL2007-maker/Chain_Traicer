import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { ThemeProvider } from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: "FinGuard Intelligence · Cross-Bank Financial Crime Command",
  description:
    "Privacy-preserving, multi-agent AI console for cross-institution financial crime detection.",
};

// Declared explicitly so phones lay the app out at device width instead of
// pretending to be a 980px desktop and shrinking everything. maximumScale is
// left alone on purpose — pinch-zoom stays available, which matters for the
// transaction table and the graph canvas. Desktop ignores all of this.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#07090d",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen" style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}>
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
