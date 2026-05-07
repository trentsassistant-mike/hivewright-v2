"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { HiveSwitcher } from "@/components/hive-switcher";
import { NavLinks } from "@/components/nav-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { EaChatEntryButton, EaChatPanel } from "@/components/ea-chat-panel";
import { GlobalCallEaButton } from "@/components/voice/global-call-ea-button";

function HexLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id="hex-logo-bevel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFE89A" />
          <stop offset="50%" stopColor="#E59A1B" />
          <stop offset="100%" stopColor="#5C3206" />
        </linearGradient>
        <linearGradient id="hex-logo-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFE89A" />
          <stop offset="30%" stopColor="#FFB836" />
          <stop offset="55%" stopColor="#B86E08" />
          <stop offset="80%" stopColor="#FFB836" />
          <stop offset="100%" stopColor="#FFE89A" />
        </linearGradient>
      </defs>
      <polygon points="20,11 15.5,18.79 6.5,18.79 2,11 6.5,3.21 15.5,3.21" fill="url(#hex-logo-bevel)" stroke="#FFE89A" strokeWidth="0.6" strokeOpacity="0.7" />
      <polygon points="18.94,11 14.97,17.86 7.03,17.86 3.06,11 7.03,4.14 14.97,4.14" fill="url(#hex-logo-face)" stroke="#000" strokeWidth="0.5" strokeOpacity="0.32" />
      <g stroke="#FFE89A" strokeWidth="1.2" fill="none" strokeLinecap="round">
        <line x1="8.4" y1="7.6" x2="8.4" y2="14.4" />
        <line x1="13.6" y1="7.6" x2="13.6" y2="14.4" />
        <line x1="8.4" y1="11" x2="13.6" y2="11" />
      </g>
    </svg>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarState, setSidebarState] = useState(() => ({
    open: false,
    pathname,
  }));
  const [chatOpen, setChatOpen] = useState(false);
  const sidebarOpen = sidebarState.open && sidebarState.pathname === pathname;

  useEffect(() => {
    if (sidebarOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [sidebarOpen]);

  const closeSidebar = () => {
    setSidebarState((current) => (current.open ? { ...current, open: false } : current));
  };

  const openSidebar = () => {
    setSidebarState({ open: true, pathname });
  };

  const toggleChat = () => {
    setChatOpen((current) => !current);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 backdrop-blur-[1px] md:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={[
          "fixed inset-y-0 left-0 z-30 flex w-[min(18rem,calc(100vw-2rem))] flex-col border-r border-sidebar-border bg-sidebar/98 text-sidebar-foreground shadow-2xl shadow-black/40 backdrop-blur-xl",
          "transition-transform duration-200 ease-in-out",
          "md:static md:w-64 md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
      >
        {/* Sidebar header */}
        <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4">
          <Link
            href="/"
            className="flex items-center gap-2 font-heading text-lg font-semibold tracking-tight text-foreground"
            onClick={closeSidebar}
          >
            <HexLogo />
            HiveWright
          </Link>
          <button
            onClick={closeSidebar}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45 md:hidden"
            aria-label="Close navigation"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        {/* Hive context */}
        <div className="space-y-2 p-3">
          <HiveSwitcher />
          <EaChatEntryButton open={chatOpen} onToggle={toggleChat} />
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          <NavLinks onClose={closeSidebar} />
        </nav>

        {/* Footer */}
        <div className="border-t border-sidebar-border p-3">
          <ThemeToggle />
        </div>
      </aside>

      {/* Main area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Desktop top bar */}
        <header className="hidden h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/92 px-6 backdrop-blur-xl md:flex">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground/75">
              HiveWright
            </p>
            <p className="truncate text-sm font-medium text-foreground">
              Command center
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <GlobalCallEaButton placement="desktop" />
          </div>
        </header>

        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-xl md:hidden">
          <button
            onClick={openSidebar}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
            aria-label="Open navigation"
          >
            <Menu aria-hidden="true" className="size-5" />
          </button>
          <Link href="/" className="flex min-w-0 items-center gap-2 font-heading text-lg font-semibold tracking-tight text-foreground focus-visible:ring-2 focus-visible:ring-ring/45">
            <HexLogo />
            <span className="truncate">HiveWright</span>
          </Link>
          <div className="ml-auto shrink-0">
            <GlobalCallEaButton placement="mobile" />
          </div>
        </header>

        {/* Page content */}
        <main className="hive-surface flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1440px] p-4 pb-24 sm:p-6 sm:pb-24 md:pb-6 lg:p-8">{children}</div>
        </main>
      </div>
      <EaChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />
    </div>
  );
}
