import { describe, expect, it } from "vitest";
import { buildGoalCreatedNotificationMessage } from "@/dispatcher/goal-notification";

describe("buildGoalCreatedNotificationMessage", () => {
  it("preserves the idea-origin preface and appends the goal brief excerpt", () => {
    const ideaId = "11111111-1111-1111-1111-111111111111";
    const message = buildGoalCreatedNotificationMessage(
      `From your idea ${ideaId}: Ideas digest\n\nCreate a daily digest that reviews and promotes the best ideas.`,
    );

    expect(message).toContain(`From your idea ${ideaId}: Ideas digest`);
    expect(message).toContain("Create a daily digest");
  });

  it("keeps non-idea goal notifications unchanged", () => {
    const description = "Plain goal brief without any idea-origin metadata.";
    expect(buildGoalCreatedNotificationMessage(description)).toBe(description);
  });

  it("falls back to the legacy default when the goal has no description", () => {
    expect(buildGoalCreatedNotificationMessage(null)).toContain("Supervisor is starting now");
  });
});
