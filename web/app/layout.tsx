import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import "./product.css";
import { SiteFooter } from "@/components/Nav";

const display = localFont({
  src: "../public/fonts/inter-variable.ttf",
  variable: "--font-display-modern",
  display: "swap",
  weight: "100 900",
});
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "MCPal — PayPal for AI agents in 8 verbs",
  description:
    "An MCP server and library that turns PayPal's API-level agent tools into 8 intent-level verbs with idempotency, holds, payouts, policy limits and a hash-chained decision log. Runs on the PayPal sandbox.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
