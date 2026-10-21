import type { LogType } from "./types";

/**
 * Start playback immediately after load. Browsers block autoplay with audio,
 * so if the first attempt is rejected we retry muted (which is always allowed)
 * and warn the user.
 */
export async function autoplay(
  video: HTMLVideoElement,
  log: (type: LogType, msg: string) => void
): Promise<void> {
  try {
    await video.play();
  } catch {
    try {
      video.muted = true;
      await video.play();
      log("warn", "Autoplay policy: started muted — unmute in the controls.");
    } catch (e: any) {
      log("warn", "Autoplay blocked: press play. " + (e?.message || ""));
    }
  }
}
