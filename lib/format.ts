// Stream format detection by URL

export type StreamFormat = "dash" | "hls" | "smooth" | "unknown";

export function detectFormat(url: string): StreamFormat {
  const u = url.toLowerCase().split("?")[0];
  if (u.endsWith(".mpd")) return "dash";
  if (u.endsWith(".m3u8")) return "hls";
  if (u.endsWith(".ism") || u.includes("/manifest") || u.includes(".ism/")) {
    return "smooth";
  }
  return "unknown";
}
