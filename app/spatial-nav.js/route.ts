import { readFileSync } from "node:fs";
import path from "node:path";

// Serves the WICG spatial-navigation polyfill straight from node_modules, so the
// vendored file never drifts from the installed version. Only Tizen asks for it
// (see the loader in app/layout.tsx).
const FILE = path.join(
  process.cwd(),
  "node_modules",
  "spatial-navigation-polyfill",
  "polyfill",
  "spatial-navigation-polyfill.js"
);

// Upstream bug: isInside() compares with closed intervals, so two controls that
// merely touch (a row of tabs, sharing an edge) count as overlapping and the
// neighbour is dropped as a candidate — every arrow press skips one. Overlap has
// to be strict.
const INSIDE_BUGGY = `    const rightEdgeCheck = (containerRect.left <= childRect.right && containerRect.right >= childRect.right);
    const leftEdgeCheck = (containerRect.left <= childRect.left && containerRect.right >= childRect.left);
    const topEdgeCheck = (containerRect.top <= childRect.top && containerRect.bottom >= childRect.top);
    const bottomEdgeCheck = (containerRect.top <= childRect.bottom && containerRect.bottom >= childRect.bottom);`;
const INSIDE_FIXED = `    const rightEdgeCheck = (containerRect.left < childRect.right && containerRect.right >= childRect.right);
    const leftEdgeCheck = (containerRect.left <= childRect.left && containerRect.right > childRect.left);
    const topEdgeCheck = (containerRect.top <= childRect.top && containerRect.bottom > childRect.top);
    const bottomEdgeCheck = (containerRect.top < childRect.bottom && containerRect.bottom >= childRect.bottom);`;

function load(): string {
  // The published file has CRLF line endings.
  const src = readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
  // Fail loudly if an upgrade changed the code, rather than silently serving
  // the unpatched skip-one-tab behaviour.
  if (!src.includes(INSIDE_BUGGY)) {
    throw new Error("spatial-navigation-polyfill: isInside() changed, re-check the patch");
  }
  return src.replace(INSIDE_BUGGY, INSIDE_FIXED);
}

export function GET() {
  return new Response(load(), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
