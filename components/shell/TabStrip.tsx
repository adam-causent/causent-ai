"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Scope } from "@/lib/types";
import { FolderIcon } from "@/components/ui/icons";

const TABS = [
  { href: "/data-workshop", label: "Data Workshop" },
  { href: "/actions", label: "Actions & Decisions" },
  { href: "/impact", label: "Impact" },
  { href: "/reports", label: "Reports" },
] as const;

export function TabStrip({ scope }: { scope: Scope }) {
  const pathname = usePathname();

  return (
    <div className="relative flex h-12 items-center border-b border-[var(--border)] bg-[var(--surface)] px-5">
      {/* project breadcrumb — namespaces every metric/action/edge to a scope.
          Hidden below lg: the centered tab nav would collide with it. */}
      <div className="hidden items-center gap-2 text-[13px] lg:flex">
        <FolderIcon className="text-[var(--text-subtle)]" />
        <span className="text-[var(--text-muted)]">Project:</span>
        <span className="font-medium text-[var(--brand-blue)]">{scope.project}</span>
        <span className="text-[var(--text-subtle)]">/</span>
        <span className="font-semibold text-[var(--text)]">{scope.workspace}</span>
      </div>

      {/* tabs — persistent across the whole flow. Statically laid out (scrollable)
          on small screens; absolutely centered only once the breadcrumb fits. */}
      <nav className="scroll-slim flex h-full items-center gap-5 overflow-x-auto lg:absolute lg:left-1/2 lg:-translate-x-1/2 lg:gap-7 lg:overflow-x-visible">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`relative flex h-full items-center whitespace-nowrap text-[14px] transition-colors ${
                active
                  ? "font-semibold text-[var(--text)]"
                  : "font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {tab.label}
              {active && (
                <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-[var(--brand-blue)]" />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
