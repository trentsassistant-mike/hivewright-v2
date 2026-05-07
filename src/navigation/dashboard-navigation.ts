export type DashboardNavigationContext = {
  activeHiveId?: string;
  qualityFeedbackCount?: number;
};

export type DashboardNavigationLink = {
  id: string;
  href: string;
  label: string;
  badgeCount?: number;
  isActive?: (pathname: string) => boolean;
};

export type DashboardNavigationGroup = {
  id: string;
  label: string;
  href?: string;
  isActive?: (pathname: string) => boolean;
  links: DashboardNavigationLink[];
  global?: boolean;
};

function hiveHref(activeHiveId: string | undefined, section: "ideas" | "initiatives" | "files") {
  return activeHiveId ? `/hives/${activeHiveId}/${section}` : "/hives";
}

function hiveSectionIsActive(section: "ideas" | "initiatives" | "files", href: string) {
  return (pathname: string) =>
    pathname === href || (pathname.startsWith("/hives/") && pathname.endsWith(`/${section}`));
}

export function dashboardNavigationLinkIsActive(link: DashboardNavigationLink, pathname: string) {
  return link.isActive
    ? link.isActive(pathname)
    : pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href));
}

export function dashboardNavigationGroupIsActive(group: DashboardNavigationGroup, pathname: string) {
  if (group.isActive?.(pathname)) return true;
  if (
    group.href &&
    (pathname === group.href || (group.href !== "/" && pathname.startsWith(group.href)))
  ) {
    return true;
  }
  return group.links.some((link) => dashboardNavigationLinkIsActive(link, pathname));
}

export function buildDashboardNavigation({
  activeHiveId,
  qualityFeedbackCount = 0,
}: DashboardNavigationContext): DashboardNavigationGroup[] {
  const ideasHref = hiveHref(activeHiveId, "ideas");
  const initiativesHref = hiveHref(activeHiveId, "initiatives");
  const filesHref = hiveHref(activeHiveId, "files");

  return [
    {
      id: "dashboard",
      label: "Dashboard",
      href: "/",
      isActive: (pathname) => pathname === "/",
      links: [],
    },
    {
      id: "work",
      label: "Work",
      href: "/tasks",
      links: [
        { id: "tasks", href: "/tasks", label: "Tasks" },
        { id: "goals", href: "/goals", label: "Goals" },
        {
          id: "initiatives",
          href: initiativesHref,
          label: "Initiatives",
          isActive: hiveSectionIsActive("initiatives", initiativesHref),
        },
        { id: "work-intake", href: "/intake", label: "Work Intake" },
        { id: "projects", href: "/projects", label: "Projects" },
        {
          id: "ideas",
          href: ideasHref,
          label: "Ideas",
          isActive: hiveSectionIsActive("ideas", ideasHref),
        },
      ],
    },
    {
      id: "inbox",
      label: "Inbox",
      href: "/decisions",
      links: [
        { id: "decisions", href: "/decisions", label: "Decisions" },
        {
          id: "quality-feedback",
          href: "/quality-feedback",
          label: "Quality feedback",
          badgeCount: qualityFeedbackCount > 0 ? qualityFeedbackCount : undefined,
        },
      ],
    },
    {
      id: "schedules",
      label: "Schedules",
      href: "/schedules",
      links: [],
    },
    {
      id: "memory",
      label: "Memory",
      href: "/memory",
      links: [
        { id: "memory", href: "/memory", label: "Memory" },
        { id: "memory-health", href: "/memory/health", label: "Memory Health" },
        { id: "memory-timeline", href: "/memory/timeline", label: "Memory Timeline" },
        { id: "insights", href: "/memory/insights", label: "Insights" },
      ],
    },
    {
      id: "analytics",
      label: "Analytics",
      href: "/analytics",
      links: [],
    },
    {
      id: "operations",
      label: "Operations",
      href: "/roles",
      links: [
        { id: "roles", href: "/roles", label: "Roles" },
        { id: "board", href: "/board", label: "Board" },
        { id: "voice", href: "/voice", label: "Voice" },
        {
          id: "files",
          href: filesHref,
          label: "Files",
          isActive: hiveSectionIsActive("files", filesHref),
        },
        { id: "screen-capture", href: "/setup/workflow-capture", label: "Screen capture" },
        { id: "workflow-capture", href: "/setup/sop-importer", label: "Workflow capture" },
        { id: "docs", href: "/docs", label: "Docs" },
      ],
    },
    {
      id: "setup",
      label: "Setup",
      href: "/setup",
      links: [
        { id: "setup", href: "/setup", label: "Setup", isActive: (pathname) => pathname === "/setup" },
        { id: "models", href: "/setup/models", label: "Models" },
        { id: "connectors", href: "/setup/connectors", label: "Connectors" },
        { id: "setup-health", href: "/setup/health", label: "Setup Health" },
        { id: "embedding-settings", href: "/setup/embeddings", label: "Embedding settings" },
        { id: "updates", href: "/setup/updates", label: "Updates" },
      ],
    },
    {
      id: "global",
      label: "Global",
      global: true,
      links: [
        { id: "hives", href: "/hives", label: "Hives" },
        {
          id: "global-settings",
          href: "/setup",
          label: "Global Settings",
          isActive: (pathname) => pathname === "/setup",
        },
      ],
    },
  ];
}
