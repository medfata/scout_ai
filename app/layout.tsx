import type { Metadata, Viewport } from "next";

import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/**
 * Root layout. Scout is a private single-user tool (section 1), so there is no
 * marketing chrome and the page is `noindex`. Dark mode is class-based; the
 * inline script below applies the stored/system theme before first paint so the
 * console never flashes white.
 */

export const metadata: Metadata = {
  title: {
    default: "Scout",
    template: "%s · Scout",
  },
  description: "Private client-finding and outreach console.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#101214" },
  ],
};

const THEME_INIT_SCRIPT = `(function(){try{var stored=localStorage.getItem("scout-theme");var dark=stored?stored==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",dark);}catch(error){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router layout, not pages/_document. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="bg-background text-foreground min-h-svh font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
