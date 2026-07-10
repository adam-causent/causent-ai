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
      {/* project breadcrumb — namespaces every metric/action/edge to a scope */}
      <div className="flex items-center gap-2 text-[13px]">
        <FolderIcon className="text-[var(--text-subtle)]" />
        <span className="text-[var(--text-muted)]">Project:</span>
        <span className="font-medium text-[var(--brand-blue)]">{scope.project}</span>
        <span className="text-[var(--text-subtle)]">/</span>
        <span className="font-semibold text-[var(--text)]">{scope.workspace}</span>
      </div>

      {/* tabs — persistent across the whole flow */}
      <nav className="absolute left-1/2 flex h-full -translate-x-1/2 items-center gap-7">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`relative flex h-full items-center text-[14px] transition-colors ${
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
