"use client";

import { useEffect } from "react";
import { isTextField, isTizen, isTvWrapper } from "@/lib/tv";

const LOCKED = "data-tv-locked";

// Samsung's IME reports its own Done / Cancel keys instead of Enter / Escape.
const TIZEN_IME_DONE = 65376;
const TIZEN_IME_CANCEL = 65385;

const ARROWS: Record<string, string> = {
  ArrowLeft: "left",
  ArrowUp: "up",
  ArrowRight: "right",
  ArrowDown: "down",
};

/**
 * Keep the on-screen keyboard out of the way on a TV.
 *
 * Android and Tizen both pop the IME as soon as a text field takes focus, so
 * merely passing over the sidebar with the D-pad buries the UI under a keyboard.
 * Fields are therefore locked — focusable, but raising no keyboard — and only
 * unlocked when the user presses OK/Enter on one. Leaving the field locks it
 * again.
 *
 * Fields are re-scanned as the form changes (picking another engine swaps whole
 * sections in and out).
 */
export function useTvKeyboard(): void {
  useEffect(() => {
    const tizen = isTizen();
    if (!isTvWrapper() && !tizen) return;

    // `inputmode=none` is the standard way to say "focusable, but don't raise the
    // virtual keyboard" — unlike readOnly it doesn't block typing once unlocked.
    // Samsung's IME ignores it, so on Tizen the field is also made readOnly.
    const lock = (el: HTMLInputElement | HTMLTextAreaElement) => {
      if (el.hasAttribute(LOCKED)) return;
      el.setAttribute(LOCKED, "");
      el.inputMode = "none";
      if (tizen) el.readOnly = true;
    };
    const unlock = (el: HTMLInputElement | HTMLTextAreaElement) => {
      el.removeAttribute(LOCKED);
      el.inputMode = "text";
      if (tizen) el.readOnly = false;
    };

    // The field currently being edited — it must survive a re-scan, otherwise the
    // observer below re-locks it the moment React touches the DOM.
    let editing: HTMLInputElement | HTMLTextAreaElement | null = null;
    // Set while Tizen re-focuses a field to raise its keyboard, so the blur that
    // takes doesn't count as leaving the field.
    let refocusing = false;

    const lockAll = () => {
      document.querySelectorAll("input, textarea").forEach((el) => {
        if (isTextField(el) && el !== editing) lock(el);
      });
    };
    lockAll();

    // The wrapper exposes the IME, because Android won't raise the keyboard for a
    // programmatic focus — only for a real gesture or an explicit native call.
    const bridge = () =>
      (window as unknown as { StreamProbeTV?: { showKeyboard(): void; hideKeyboard(): void } })
        .StreamProbeTV;

    const startEditing = (el: HTMLInputElement | HTMLTextAreaElement) => {
      editing = el;
      unlock(el);
      el.setSelectionRange?.(el.value.length, el.value.length);
      if (tizen) {
        // Tizen raises its IME on focus, but only for a field that is editable
        // at that moment — so focus it again now that it is.
        refocusing = true;
        el.blur();
        el.focus();
        refocusing = false;
      } else {
        // Android TV ignores the keyboard for a programmatic focus, so JS alone
        // can't do it: ask the wrapper for a forced native call.
        bridge()?.showKeyboard();
      }
    };
    const stopEditing = (el: HTMLInputElement | HTMLTextAreaElement) => {
      // Drop the keyboard but keep the focus ring.
      editing = null;
      lock(el);
      bridge()?.hideKeyboard();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (!isTextField(el)) return;
      const locked = el.hasAttribute(LOCKED);

      if (!locked && (e.keyCode === TIZEN_IME_DONE || e.keyCode === TIZEN_IME_CANCEL)) {
        stopEditing(el);
        return;
      }

      // A locked field is just a stop on the way: the arrows leave it, instead of
      // walking the caret through its text as the spatial-navigation polyfill
      // does for any input. (StreamProbe's pane jump runs earlier, on window, and
      // has already claimed Left/Right when it applies.)
      const dir = ARROWS[e.key];
      if (dir && locked && tizen && !e.defaultPrevented) {
        e.preventDefault();
        (window as unknown as { navigate?: (d: string) => void }).navigate?.(dir);
        return;
      }

      // OK on the remote arrives as Enter: on a locked field it starts editing,
      // on the field being edited it finishes.
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (locked) startEditing(el);
      else stopEditing(el);
    };

    // Leaving a field always re-locks it, so it can't be re-entered "hot".
    const onFocusOut = (e: FocusEvent) => {
      if (refocusing) return;
      const el = e.target;
      if (isTextField(el as Element)) {
        if (el === editing) editing = null;
        lock(el as HTMLInputElement);
        bridge()?.hideKeyboard();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    const obs = new MutationObserver(lockAll);
    obs.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
      obs.disconnect();
    };
  }, []);
}
