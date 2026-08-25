import "./globals.css";
import type { Metadata } from "next";
import { ThemeProvider } from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: "CryptoTrace — SIH26183 · I4C Blockchain Forensics",
  description:
    "Real-time identification of fraud-linked cryptocurrency exchanges from victim-reported suspect wallet addresses. SIH26183 · Ministry of Home Affairs / Indian Cyber Crime Coordination Centre (I4C).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Default to dark; ThemeProvider reads the saved preference on the client and
  // swaps the class if the user last chose light.
  return (
    <html lang="en" className="dark">
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
