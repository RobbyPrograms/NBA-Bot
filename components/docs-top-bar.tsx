"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/rolibot-ui";

export function DocsTopBar() {
  return (
    <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-4 py-6 sm:px-6">
      <Link
        href="/"
        className="text-sm font-semibold text-[var(--accent)] transition hover:text-[var(--accent-2)]"
      >
        ← Dashboard
      </Link>
      <div className="flex items-center gap-3">
        <p className="font-mono text-xs text-[var(--muted)]">RoliBot NBA · docs</p>
        <ThemeToggle />
      </div>
    </div>
  );
}
