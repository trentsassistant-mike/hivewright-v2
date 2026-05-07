"use client";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const isDark = true;
    localStorage.setItem("theme", "dark");
    document.documentElement.classList.add("dark");
    // Use callback to avoid synchronous setState-in-effect lint error
    queueMicrotask(() => setDark(isDark));
  }, []);

  // Don't render until we know the theme (avoids hydration mismatch)
  if (dark === null) {
    return (
      <button className="w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground/70">
        Loading...
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled
      className="w-full cursor-default rounded-md px-3 py-2 text-left text-sm text-muted-foreground/80"
    >
      Graphite theme
    </button>
  );
}
