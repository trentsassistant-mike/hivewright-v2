import { describe, expect, it } from "vitest";
import {
  buildDashboardNavigation,
  dashboardNavigationGroupIsActive,
  dashboardNavigationLinkIsActive,
} from "../../src/navigation/dashboard-navigation";

describe("dashboard navigation model", () => {
  it("keeps setup canonical and global items visually separated without settings hrefs", () => {
    const groups = buildDashboardNavigation({
      activeHiveId: "hive-2",
      qualityFeedbackCount: 4,
    });
    const links = groups.flatMap((group) => group.links.map((link) => ({ ...link, groupId: group.id })));

    expect(groups.map((group) => group.id)).toEqual([
      "dashboard",
      "work",
      "inbox",
      "schedules",
      "memory",
      "analytics",
      "operations",
      "setup",
      "global",
    ]);
    expect(groups.find((group) => group.id === "global")?.global).toBe(true);
    expect(groups.find((group) => group.id === "work")).toMatchObject({
      href: "/tasks",
      label: "Work",
    });
    expect(groups.find((group) => group.id === "memory")).toMatchObject({
      href: "/memory",
      label: "Memory",
    });
    expect(links.find((link) => link.id === "global-settings")).toMatchObject({
      href: "/setup",
      label: "Global Settings",
      groupId: "global",
    });
    expect(links.find((link) => link.id === "updates")).toMatchObject({
      href: "/setup/updates",
      label: "Updates",
      groupId: "setup",
    });
    expect(links.map((link) => link.href).filter((href) => href.startsWith("/settings"))).toEqual([]);
  });

  it("frames pipeline and capture routes as Procedures instead of separate Operations tools", () => {
    const groups = buildDashboardNavigation({ activeHiveId: "hive-2" });
    const links = groups.flatMap((group) => group.links.map((link) => ({ ...link, groupId: group.id })));
    const procedures = links.find((link) => link.href === "/pipelines");
    const operations = groups.find((group) => group.id === "operations");
    const work = groups.find((group) => group.id === "work");

    expect(procedures).toMatchObject({
      id: "procedures",
      label: "Procedures",
      groupId: "work",
    });
    expect(operations?.links.map((link) => link.href)).not.toContain("/setup/workflow-capture");
    expect(operations?.links.map((link) => link.href)).not.toContain("/setup/sop-importer");
    expect(procedures && dashboardNavigationLinkIsActive(procedures, "/pipelines")).toBe(true);
    expect(procedures && dashboardNavigationLinkIsActive(procedures, "/setup/workflow-capture")).toBe(true);
    expect(procedures && dashboardNavigationLinkIsActive(procedures, "/setup/sop-importer")).toBe(true);
    expect(work && dashboardNavigationGroupIsActive(work, "/setup/workflow-capture/session-1/review")).toBe(true);
  });
});
