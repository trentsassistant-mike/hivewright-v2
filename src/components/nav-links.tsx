"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useHiveContext } from "@/components/hive-context";
import {
  buildDashboardNavigation,
  dashboardNavigationGroupIsActive,
  dashboardNavigationLinkIsActive,
  type DashboardNavigationGroup,
  type DashboardNavigationLink,
} from "@/navigation/dashboard-navigation";

export function NavLinks({ onClose }: { onClose?: () => void }) {
  const pathname = usePathname();
  const { selected, hives } = useHiveContext();
  const activeHiveId = selected?.id ?? hives[0]?.id;
  const { data: qualityFeedbackCount = 0 } = useQuery({
    queryKey: ["nav-quality-feedback", activeHiveId],
    enabled: Boolean(activeHiveId),
    queryFn: async () => {
      if (!activeHiveId) return 0;
      const res = await fetch(`/api/brief?hiveId=${activeHiveId}`);
      if (!res.ok) return 0;
      const body = await res.json();
      return Number(body.data?.flags?.pendingQualityFeedback ?? 0);
    },
    refetchInterval: 30_000,
  });
  const groups = buildDashboardNavigation({
    activeHiveId,
    qualityFeedbackCount,
  });

  const linkClassName = (isActive: boolean, indented = false) =>
    `flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/45 ${
      indented ? "ml-3" : ""
    } ${
      isActive
        ? "border-amber-400/25 bg-sidebar-accent font-medium text-foreground shadow-[inset_2px_0_0_rgba(255,197,98,0.85),inset_0_0_0_1px_rgba(255,197,98,0.13)]"
        : "border-transparent text-muted-foreground hover:border-white/[0.06] hover:bg-white/[0.045] hover:text-foreground"
    }`;

  const renderLink = (link: DashboardNavigationLink, indented = false) => {
    const isActive = dashboardNavigationLinkIsActive(link, pathname);
    return (
      <li key={link.id}>
        <Link
          href={link.href}
          onClick={onClose}
          aria-current={isActive ? "page" : undefined}
          className={linkClassName(isActive, indented)}
        >
          <span className="min-w-0 truncate">{link.label}</span>
          {renderBadge(link.badgeCount)}
        </Link>
      </li>
    );
  };

  const renderBadge = (badgeCount?: number) => badgeCount ? (
    <span
      aria-hidden="true"
      className="min-w-5 rounded-full bg-primary/18 px-1.5 py-0.5 text-center text-xs font-semibold leading-none text-amber-100"
    >
      {badgeCount}
    </span>
  ) : null;

  const renderGroupTopLink = (group: DashboardNavigationGroup, isExpanded: boolean) => {
    if (!group.href) return null;
    const badgeCount = group.links.reduce((total, link) => total + (link.badgeCount ?? 0), 0);
    return (
      <Link
        href={group.href}
        onClick={onClose}
        aria-current={isExpanded ? "page" : undefined}
        aria-expanded={group.links.length > 0 ? isExpanded : undefined}
        className={linkClassName(isExpanded)}
      >
        <span className="min-w-0 truncate">{group.label}</span>
        {renderBadge(badgeCount)}
      </Link>
    );
  };

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const headingId = `dashboard-nav-${group.id}`;
        const isExpanded = dashboardNavigationGroupIsActive(group, pathname);
        const visibleLinks = group.global || !group.href
          ? group.links
          : isExpanded
            ? group.links.filter((link) => !(link.href === group.href && link.label === group.label))
            : [];
        return (
          <section
            key={group.id}
            role="group"
            aria-labelledby={headingId}
            className={group.global ? "border-t border-sidebar-border pt-3" : undefined}
          >
            <h2
              id={headingId}
              className="px-3 pb-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
            >
              {group.label}
            </h2>
            <div className="space-y-1">
              {renderGroupTopLink(group, isExpanded)}
              {visibleLinks.length > 0 ? (
                <ul className="space-y-1">
                  {visibleLinks.map((link) => renderLink(link, Boolean(group.href && !group.global)))}
                </ul>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
