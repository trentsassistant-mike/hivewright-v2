"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

const baseLinkClass =
  "rounded-full border px-3 py-1.5 text-sm transition-colors";

function linkClass(isActive: boolean) {
  return isActive
    ? `${baseLinkClass} border-amber-300 bg-amber-200/70 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100`
    : `${baseLinkClass} border-amber-200/70 text-amber-900/80 hover:bg-amber-100/70 hover:text-amber-950 dark:border-white/[0.08] dark:text-zinc-300/85 dark:hover:bg-white/[0.04] dark:hover:text-amber-100`;
}

export function HiveSectionNav({ hiveId }: { hiveId: string }) {
  const pathname = usePathname();
  const { data: qualityFeedbackCount = 0 } = useQuery({
    queryKey: ["hive-section-quality-feedback", hiveId],
    queryFn: async () => {
      const res = await fetch(`/api/brief?hiveId=${hiveId}`);
      if (!res.ok) return 0;
      const body = await res.json();
      return Number(body.data?.flags?.pendingQualityFeedback ?? 0);
    },
    refetchInterval: 30_000,
  });
  const links = [
    { href: `/hives/${hiveId}`, label: "Targets" },
    { href: `/hives/${hiveId}/ideas`, label: "Ideas" },
    { href: `/hives/${hiveId}/initiatives`, label: "Initiatives" },
    { href: `/hives/${hiveId}/files`, label: "Files" },
    { href: `/goals?hiveId=${hiveId}`, label: "Goals" },
    { href: `/decisions?hiveId=${hiveId}`, label: "Decisions" },
    ...(qualityFeedbackCount > 0
      ? [{ href: `/quality-feedback?hiveId=${hiveId}`, label: "Quality feedback" }]
      : []),
  ];

  return (
    <nav
      aria-label="Hive sections"
      className="flex flex-wrap gap-2"
    >
      {links.map((link) => {
        const isActive = pathname === link.href || pathname === link.href.split("?")[0];
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? "page" : undefined}
            className={linkClass(isActive)}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
