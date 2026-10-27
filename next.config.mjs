/**
 * SP_TV_EXPORT=1 builds the static UI that gets packaged inside a TV app (see
 * app/api/deploy). It runs from file:// there — the only origin where the TV
 * runtime exposes EME — and talks to the Mac's server through ?api=.
 *   - pageExtensions "tsx" leaves out the route handlers (route.ts), which a
 *     static export cannot contain; the UI calls them on the Mac instead.
 *   - scripts/tv-export.mjs then makes the /_next/… asset paths relative, so
 *     they resolve next to index.html on file:// (next/font rejects a relative
 *     assetPrefix, so it can't be done here).
 *   - its own distDir, so it never clobbers the .next of a running server.
 */
const tvExport = process.env.SP_TV_EXPORT === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ESLint is optional for this tool; skip it during production builds so the
  // build does not require the eslint-config-next toolchain to be installed.
  eslint: { ignoreDuringBuilds: true },
  ...(tvExport && {
    output: "export",
    distDir: ".next-tv",
    pageExtensions: ["tsx", "jsx"],
    images: { unoptimized: true },
  }),
};

export default nextConfig;
