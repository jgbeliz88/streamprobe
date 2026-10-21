import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "StreamProbe — Player Testing Tool",
  description: "Multi-engine video player QA tool by AgileTV · DASH · HLS · DRM",
};

// Without this, iOS Safari lays the page out at 980px and everything renders
// tiny. `viewport-fit=cover` lets the layout use the safe-area insets.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0B0E16",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={`${inter.variable} ${jetbrains.variable}`}>
      <head>
        {/*
          Samsung's Tizen web engine ships without Chromium's spatial navigation
          (webOS has it built in), so the remote's arrows move nothing. Load the
          polyfill there only: elsewhere it would hijack the arrow keys. It must
          be parser-inserted, because it only binds its handler on window `load`.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if(/Tizen/.test(navigator.userAgent)){var s=document.createElement("script");s.src="/spatial-nav.js";s.async=false;document.head.appendChild(s)}`,
          }}
        />
      </head>
      <body className="font-sans text-sm">{children}</body>
    </html>
  );
}
