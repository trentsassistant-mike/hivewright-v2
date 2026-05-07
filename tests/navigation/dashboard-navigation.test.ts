import { describe, expect, it } from "vitest";
import { buildDashboardNavigation } from "../../src/navigation/dashboard-navigation";

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
    expect(links.map((link) => link.href).filter((href) => href.startsWith("/settings"))).toEqual([]);
  });
});
