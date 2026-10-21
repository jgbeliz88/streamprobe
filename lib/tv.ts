/**
 * True when running inside the Android TV wrapper, which appends a marker to
 * its User-Agent. Used to enable remote-control behaviour that would be wrong
 * on a phone or a desktop browser.
 */
export function isTvWrapper(): boolean {
  return typeof navigator !== "undefined" && /StreamProbeTV/.test(navigator.userAgent);
}

/** True on a Samsung TV — the packaged Tizen app or the TV's own browser. */
export function isTizen(): boolean {
  return typeof navigator !== "undefined" && /Tizen/.test(navigator.userAgent);
}

/**
 * True on any TV runtime: LG webOS, Samsung Tizen or the Android TV wrapper.
 * There, downloading a file goes nowhere, so exports are sent to the server.
 */
export function isTv(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (/Web0S|webOS|Tizen/i.test(navigator.userAgent) || isTvWrapper())
  );
}

/** Text-entry fields, i.e. the ones that pop the on-screen keyboard. */
export function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return type === "text" || type === "number" || type === "url" || type === "search";
}

/**
 * Props that make a non-button element (a table row, a flex header) reachable
 * and pressable with a TV remote: focusable, and OK/Enter fires the same action
 * as a click. For anything that can simply be a <button>, use a <button>.
 */
export function pressable(onPress: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: {
      key: string;
      target: unknown;
      currentTarget: unknown;
      preventDefault(): void;
    }) => {
      // Only the element itself: OK on a button nested inside must not toggle it.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPress();
      }
    },
  };
}
