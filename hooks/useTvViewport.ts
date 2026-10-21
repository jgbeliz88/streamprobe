"use client";

import { useEffect } from "react";
import { isTvWrapper } from "@/lib/tv";

/**
 * Size the viewport for a TV.
 *
 * A TV panel reports a high density (a 1080p set is typically 320dpi, i.e.
 * devicePixelRatio 2), so the standard `width=device-width` hands the page a
 * 960px viewport that is then painted at 2x: everything looks enormous and the
 * menus fall off the screen. A phone genuinely wants device-width, so this only
 * kicks in inside the Android TV wrapper, which marks its User-Agent.
 *
 * It has to run from the page rather than from the wrapper: the framework
 * rewrites <head> during hydration and drops any tag injected from outside.
 * The observer re-applies the value if that happens again.
 */
export function useTvViewport(): void {
  useEffect(() => {
    if (!isTvWrapper()) return;
    const dpr = window.devicePixelRatio || 1;
    if (dpr <= 1) return; // nothing to correct

    // Physical pixels across the panel; lay out at that width and scale by
    // 1/dpr so one CSS pixel lands on one real pixel.
    const width = Math.round(window.screen.width * dpr);
    const scale = (1 / dpr).toFixed(4);
    const content = `width=${width}, initial-scale=${scale}, minimum-scale=${scale}, maximum-scale=${scale}`;

    const meta =
      document.querySelector<HTMLMetaElement>('meta[name="viewport"]') ??
      (() => {
        const m = document.createElement("meta");
        m.name = "viewport";
        document.head.appendChild(m);
        return m;
      })();

    let ours = false;
    const apply = () => {
      if (meta.content === content) return;
      ours = true;
      meta.content = content;
      ours = false;
    };
    apply();

    const obs = new MutationObserver(() => {
      if (!ours) apply();
    });
    obs.observe(meta, { attributes: true, attributeFilter: ["content"] });
    return () => obs.disconnect();
  }, []);
}
