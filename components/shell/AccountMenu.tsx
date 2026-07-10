"use client";

import { useEffect, useRef, useState } from "react";

// The header account chip. v1 demo: opens a small menu showing the demo
// identity; "Sign out" is present but disabled until auth lands (SEC2 —
// docs/designs/security-and-auth.md). Honest chrome: nothing here pretends
// to do something it can't.

const DEMO_USER = { initials: "AK", name: "Adam K.", detail: "Demo workspace" };

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-1">
      <button
        type="button"
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--brand-grey)] text-[12px] font-semibold text-white hover:brightness-110"
      >
        {DEMO_USER.initials}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-50 w-56 rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1.5 shadow-lg"
        >
          <div className="border-b border-[var(--border)] px-3.5 pb-2.5 pt-1.5">
            <div className="text-[13px] font-semibold text-[var(--text)]">
              {DEMO_USER.name}
            </div>
            <div className="text-[12px] text-[var(--text-muted)]">
              {DEMO_USER.detail}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            disabled
            title="Sign-in/out arrives with auth (SEC2)"
            className="mt-1 flex w-full cursor-not-allowed items-center px-3.5 py-2 text-left text-[13px] text-[var(--text-subtle)]"
          >
            Sign out
            <span className="ml-auto text-[11px]">coming with auth</span>
          </button>
        </div>
      )}
    </div>
  );
}
