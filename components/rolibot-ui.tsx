"use client";

import Link from "next/link";
import { useTheme } from "@/app/providers";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      className="roli-btn-icon group relative flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--text)] shadow-[var(--shadow-sm)] transition hover:border-[var(--accent-2)]/50 hover:shadow-[var(--shadow-md)]"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-[var(--accent)]/10 to-[var(--accent-2)]/5 opacity-0 transition group-hover:opacity-100" />
      {isDark ? (
        <svg className="relative h-4 w-4 text-[var(--accent)]" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path d="M12 3a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1zm5.657 2.343a1 1 0 0 1 0 1.414l-.707.707a1 1 0 1 1-1.414-1.414l.707-.707a1 1 0 0 1 1.414 0zM18 11a1 1 0 1 1 0 2h-1a1 1 0 1 1 0-2h1zm-2.929 7.657a1 1 0 0 1-1.414 0l-.707-.707a1 1 0 0 1 1.414-1.414l.707.707a1 1 0 0 1 0 1.414zM12 20a1 1 0 0 1-1-1v-1a1 1 0 1 1 2 0v1a1 1 0 0 1-1 1zm-8-9a1 1 0 1 1 0-2h1a1 1 0 1 1 0 2H4zm2.343-5.657a1 1 0 0 1 1.414 0l.707.707A1 1 0 0 1 7.05 7.464l-.707-.707a1 1 0 0 1 0-1.414zM12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" />
        </svg>
      ) : (
        <svg className="relative h-4 w-4 text-violet-700" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

export function NavHowItWorks() {
  return (
    <Link
      href="/how-it-works"
      className="whitespace-nowrap text-sm font-medium text-[var(--accent-2)] underline-offset-4 transition hover:text-[var(--accent)] hover:underline"
    >
      How it works
    </Link>
  );
}

export function Card({
  children,
  className = "",
  elevated = true,
}: {
  children: React.ReactNode;
  className?: string;
  elevated?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-[var(--border)] bg-[var(--card)] ${
        elevated ? "shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-card-hover)]" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">{children}</h3>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="bg-gradient-to-r from-[var(--accent-2)] via-[var(--accent)] to-[var(--gold)] bg-clip-text text-xl font-bold tracking-tight text-transparent">
      {children}
    </h2>
  );
}

export function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 w-full rounded-xl border border-[var(--border)] bg-[var(--card-inner)] px-4 py-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold text-[var(--text)]">{value}</p>
    </div>
  );
}

export function PageBackdrop() {
  return (
    <>
      <div
        className="pointer-events-none fixed inset-0 -z-10 bg-[var(--surface-bg)]"
        aria-hidden
      />
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-40 dark:opacity-60"
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% -20%, var(--glow-1), transparent), radial-gradient(ellipse 60% 40% at 100% 0%, var(--glow-2), transparent), radial-gradient(ellipse 50% 30% at 0% 100%, var(--glow-3), transparent)",
        }}
        aria-hidden
      />
    </>
  );
}
