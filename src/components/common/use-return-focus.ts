"use client";

import { useEffect } from "react";

/**
 * The last element focused outside any dialog. While a modal is open focus is trapped inside it, so this stays the control that
 * opened it - even when the dialog moved focus into an `autoFocus` input before Radix could remember the opener.
 */
let lastOutside: Element | null = null;
let installed = false;

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (t instanceof Element && !t.closest("[role=dialog],[role=alertdialog]")) lastOutside = t;
    },
    true,
  );
}

/**
 * Dialogs/sheets opened from state (no <Trigger>) lose focus on close. Spread the result onto the Radix `Content`: on close
 * it puts focus back on the control that opened it. A handler passed in runs first and can `preventDefault()` to opt out.
 */
export function useReturnFocus(handlers: { onOpenAutoFocus?: (e: Event) => void; onCloseAutoFocus?: (e: Event) => void } = {}) {
  useEffect(() => install(), []);
  return {
    onOpenAutoFocus: handlers.onOpenAutoFocus,
    onCloseAutoFocus: (e: Event) => {
      handlers.onCloseAutoFocus?.(e);
      if (e.defaultPrevented) return;
      const el = lastOutside;
      if (el instanceof HTMLElement && el !== document.body && el.isConnected) {
        e.preventDefault();
        el.focus();
      }
    },
  };
}
