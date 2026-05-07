// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  buildOperationsMapModel,
  buildOperationsTopology,
  OperationsMapView,
} from "@/components/operations-map";

describe("buildOperationsMapModel relationship view", () => {
  it("groups active agents under their goal cluster", () => {
    const model = buildOperationsMapModel({
      supervisors: [
        {
          goalId: "goal-1",
          title: "Build the operations map",
          threadId: "thread-1",
          lastActivityAt: null,
          state: "running",
        },
      ],
      tasks: [
        {
          id: "task-a",
          title: "Render relationship view",
          assignedTo: "dev-agent",
          startedAt: null,
          modelUsed: null,
          status: "active",
          goalId: "goal-1",
          goalTitle: "Build the operations map",
        },
        {
          id: "task-b",
          title: "Direct ad-hoc task",
          assignedTo: "qa-agent",
          startedAt: null,
          modelUsed: null,
          status: "active",
          goalId: null,
          goalTitle: null,
        },
      ],
    });

    expect(model.clusters.map((c) => c.id)).toEqual(["goal-1", "__orphan__"]);
    const goalCluster = model.clusters[0];
    expect(goalCluster.goalHref).toBe("/goals/goal-1");
    expect(goalCluster.tasks.map((t) => t.id)).toEqual(["agent-task-a"]);
    expect(goalCluster.tasks[0].href).toBe("/tasks/task-a");
    expect(goalCluster.tasks[0].active).toBe(true);
    expect(model.clusters[1].goalTitle).toBe("Direct work (no goal)");
    expect(model.clusters[1].goalHref).toBeNull();
  });

  it("places critical items under the goal they block, not in a separate column", () => {
    const model = buildOperationsMapModel({
      supervisors: [],
      tasks: [],
      criticalItems: [
        {
          id: "task-blocked",
          title: "Needs owner context",
          sourceType: "task",
          status: "blocked",
          href: "/tasks/task-blocked",
          updatedAt: null,
          goalId: "goal-1",
          goalTitle: "Build the operations map",
          goalStatus: "active",
          taskId: "task-blocked",
          assignedTo: "dev-agent",
          liveBlocking: true,
        },
        {
          id: "decision-pending",
          title: "Choose runtime path",
          sourceType: "decision",
          status: "pending",
          href: "/decisions/decision-pending",
          updatedAt: null,
          goalId: "goal-1",
          goalTitle: "Build the operations map",
          goalStatus: "active",
          taskId: null,
          assignedTo: null,
          liveBlocking: true,
        },
      ],
    });

    expect(model.clusters).toHaveLength(1);
    const cluster = model.clusters[0];
    expect(cluster.goalId).toBe("goal-1");
    expect(cluster.liveCriticalCount).toBe(2);
    expect(cluster.tasks.map((t) => t.id)).toEqual([
      "task-task-blocked",
      "decision-decision-pending",
    ]);
    expect(cluster.tasks[0].kind).toBe("critical-task");
    expect(cluster.tasks[1].kind).toBe("decision");
    expect(cluster.tasks[1].href).toBe("/decisions/decision-pending");
  });

  it("treats failed tasks under achieved goals as historical, not live critical", () => {
    const model = buildOperationsMapModel({
      supervisors: [],
      tasks: [],
      criticalItems: [
        {
          id: "task-old-fail",
          title: "Old failure under finished goal",
          sourceType: "task",
          status: "failed",
          href: "/tasks/task-old-fail",
          updatedAt: null,
          goalId: "goal-done",
          goalTitle: "Already-shipped goal",
          goalStatus: "achieved",
          taskId: "task-old-fail",
          assignedTo: "dev-agent",
          liveBlocking: false,
        },
        {
          id: "task-live-fail",
          title: "Active failure under live goal",
          sourceType: "task",
          status: "failed",
          href: "/tasks/task-live-fail",
          updatedAt: null,
          goalId: "goal-live",
          goalTitle: "In-flight goal",
          goalStatus: "active",
          taskId: "task-live-fail",
          assignedTo: "dev-agent",
          liveBlocking: true,
        },
      ],
    });

    expect(model.totalLiveCritical).toBe(1);
    expect(model.totalHistoricalFailures).toBe(1);

    const liveCluster = model.clusters.find((c) => c.goalId === "goal-live");
    const doneCluster = model.clusters.find((c) => c.goalId === "goal-done");
    expect(liveCluster?.liveCriticalCount).toBe(1);
    expect(liveCluster?.historicalFailureCount).toBe(0);
    expect(liveCluster?.tasks[0].liveBlocking).toBe(true);
    expect(doneCluster?.liveCriticalCount).toBe(0);
    expect(doneCluster?.historicalFailureCount).toBe(1);
    expect(doneCluster?.tasks[0].state).toBe("history");
    expect(doneCluster?.tasks[0].liveBlocking).toBe(false);
  });

  it("sorts clusters by live critical count, then active work, then title", () => {
    const model = buildOperationsMapModel({
      supervisors: [],
      tasks: [
        {
          id: "task-active",
          title: "Working",
          assignedTo: "dev-agent",
          startedAt: null,
          modelUsed: null,
          status: "active",
          goalId: "goal-active",
          goalTitle: "B-goal",
        },
      ],
      criticalItems: [
        {
          id: "task-blocking",
          title: "Blocker",
          sourceType: "task",
          status: "failed",
          href: "/tasks/task-blocking",
          updatedAt: null,
          goalId: "goal-critical",
          goalTitle: "A-goal-critical",
          goalStatus: "active",
          taskId: "task-blocking",
          assignedTo: "dev-agent",
          liveBlocking: true,
        },
      ],
    });

    expect(model.clusters.map((c) => c.goalId)).toEqual(["goal-critical", "goal-active"]);
  });
});

describe("OperationsMapView render", () => {
  it("renders a visual topology with visible links instead of grouped cluster cards", () => {
    const model = buildOperationsMapModel({
      supervisors: [
        {
          goalId: "goal-1",
          title: "Build the operations map",
          threadId: null,
          lastActivityAt: null,
          state: "running",
        },
      ],
      tasks: [
        {
          id: "task-a",
          title: "Render relationship view",
          assignedTo: "dev-agent",
          startedAt: null,
          modelUsed: null,
          status: "active",
          goalId: "goal-1",
          goalTitle: "Build the operations map",
        },
      ],
      criticalItems: [
        {
          id: "task-blocked",
          title: "Needs owner context",
          sourceType: "task",
          status: "blocked",
          href: "/tasks/task-blocked",
          updatedAt: null,
          goalId: "goal-1",
          goalTitle: "Build the operations map",
          goalStatus: "active",
          taskId: "task-blocked",
          assignedTo: "qa-agent",
          liveBlocking: true,
        },
      ],
    });

    render(<OperationsMapView model={model} loading={false} />);

    expect(screen.getByTestId("operations-map-topology")).toBeTruthy();
    expect(screen.getAllByTestId("op-map-edge").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId("operations-map-cluster")).toBeNull();
    expect(screen.queryByTestId("op-map-task-list")).toBeNull();
  });

  it("renders nodes and connector paths in one SVG coordinate system", () => {
    const model = buildOperationsMapModel({
      supervisors: [
        {
          goalId: "goal-1",
          title: "Build the operations map",
          threadId: null,
          lastActivityAt: null,
          state: "running",
        },
      ],
      tasks: [
        {
          id: "task-a",
          title: "Render relationship view",
          assignedTo: "dev-agent",
          startedAt: null,
          modelUsed: null,
          status: "active",
          goalId: "goal-1",
          goalTitle: "Build the operations map",
        },
      ],
      criticalItems: [
        {
          id: "task-a",
          title: "Render relationship view",
          sourceType: "task",
          status: "failed",
          href: "/tasks/task-a",
          updatedAt: null,
          goalId: "goal-1",
          goalTitle: "Build the operations map",
          goalStatus: "active",
          taskId: "task-a",
          assignedTo: "dev-agent",
          liveBlocking: true,
        },
      ],
    });

    render(<OperationsMapView model={model} loading={false} />);

    const svg = screen.getByTestId("operations-map-svg");
    const anchors = screen.getAllByTestId("op-map-node-anchor");
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of anchors) {
      expect(anchor.closest("svg")).toBe(svg);
    }
    expect(document.getElementById("edge-goal-1-agent-task-a")).toBeTruthy();
    expect(document.getElementById("edge-agent-task-a-task-task-a")).toBeTruthy();
  });

  it("renders an explicit goal to active agent to blocker chain for the same task", () => {
    const model = buildOperationsMapModel({
      supervisors: [
        {
          goalId: "goal-1",
          title: "Build the operations map",
          threadId: null,
          lastActivityAt: null,
          state: "running",
        },
      ],
      tasks: [
        {
          id: "task-a",
          title: "Render relationship view",
          assignedTo: "dev-agent",
          startedAt: null,
          modelUsed: null,
          status: "active",
          goalId: "goal-1",
          goalTitle: "Build the operations map",
        },
      ],
      criticalItems: [
        {
          id: "task-a",
          title: "Render relationship view",
          sourceType: "task",
          status: "failed",
          href: "/tasks/task-a",
          updatedAt: null,
          goalId: "goal-1",
          goalTitle: "Build the operations map",
          goalStatus: "active",
          taskId: "task-a",
          assignedTo: "dev-agent",
          liveBlocking: true,
        },
      ],
    });

    const topology = buildOperationsTopology(model);
    const goalToAgent = topology.edges.find((edge) => edge.id === "edge-goal-1-agent-task-a");
    const agentToFailure = topology.edges.find((edge) => edge.id === "edge-agent-task-a-task-task-a");

    expect(goalToAgent).toMatchObject({
      from: "goal-goal-1",
      to: "goal-goal-1-agent-task-a",
      kind: "active",
    });
    expect(agentToFailure).toMatchObject({
      from: "goal-goal-1-agent-task-a",
      to: "goal-goal-1-task-task-a",
      kind: "blocking",
    });
  });

  it("renders clickable goal links and task links pointing to canonical routes", () => {
    const model = buildOperationsMapModel({
      supervisors: [
        {
          goalId: "goal-1",
          title: "Build the operations map",
          threadId: null,
          lastActivityAt: null,
          state: "running",
        },
      ],
      tasks: [
        {
          id: "task-a",
          title: "Render relationship view",
          assignedTo: "dev-agent",
          startedAt: null,
          modelUsed: null,
          status: "active",
          goalId: "goal-1",
          goalTitle: "Build the operations map",
        },
      ],
      criticalItems: [
        {
          id: "decision-1",
          title: "Choose runtime path",
          sourceType: "decision",
          status: "ea_review",
          href: "/decisions/decision-1",
          updatedAt: null,
          goalId: "goal-1",
          goalTitle: "Build the operations map",
          goalStatus: "active",
          taskId: null,
          assignedTo: null,
          liveBlocking: true,
        },
      ],
    });

    render(<OperationsMapView model={model} loading={false} />);

    const goalLink = screen.getByTestId("op-map-goal-link") as HTMLAnchorElement;
    expect(goalLink.getAttribute("href")).toBe("/goals/goal-1");
    expect(goalLink.textContent).toContain("Build the operations map");

    const taskLink = screen.getByTestId("op-map-task-link") as HTMLAnchorElement;
    expect(taskLink.getAttribute("href")).toBe("/tasks/task-a");

    const decisionLink = screen.getByTestId("op-map-decision-link") as HTMLAnchorElement;
    expect(decisionLink.getAttribute("href")).toBe("/decisions/decision-1");

    const graph = screen.getByTestId("operations-map-topology");
    expect(graph.getAttribute("data-live-critical")).toBe("true");
  });

  it("does not flag clusters without live blockers as critical", () => {
    const model = buildOperationsMapModel({
      supervisors: [],
      tasks: [],
      criticalItems: [
        {
          id: "task-old-fail",
          title: "Historical only",
          sourceType: "task",
          status: "failed",
          href: "/tasks/task-old-fail",
          updatedAt: null,
          goalId: "goal-done",
          goalTitle: "Shipped goal",
          goalStatus: "achieved",
          taskId: "task-old-fail",
          assignedTo: "dev-agent",
          liveBlocking: false,
        },
      ],
    });

    render(<OperationsMapView model={model} loading={false} />);
    const graph = screen.getByTestId("operations-map-topology");
    expect(graph.getAttribute("data-live-critical")).toBe("false");
    expect(screen.getByTestId("op-map-task-link").getAttribute("data-state")).toBe("history");
  });

  it("renders empty state when there is no activity", () => {
    const model = buildOperationsMapModel({ supervisors: [], tasks: [], criticalItems: [] });
    render(<OperationsMapView model={model} loading={false} />);
    expect(screen.getByText(/No live supervisors/)).toBeTruthy();
  });
});

describe("buildOperationsTopology", () => {
  it("keeps dense task branches attached to their goal instead of edge-stacking them", () => {
    const supervisors = Array.from({ length: 6 }, (_, index) => ({
      goalId: `goal-${index}`,
      title: `Goal ${index}`,
      threadId: null,
      lastActivityAt: null,
      state: "running" as const,
    }));
    const tasks = supervisors.map((supervisor, index) => ({
      id: `task-active-${index}`,
      title: `Active work ${index}`,
      assignedTo: "dev-agent",
      startedAt: null,
      modelUsed: null,
      status: "active",
      goalId: supervisor.goalId,
      goalTitle: supervisor.title,
    }));
    const criticalItems = supervisors.flatMap((supervisor, index) => [
      {
        id: `task-blocked-${index}`,
        title: `Blocked work ${index}`,
        sourceType: "task" as const,
        status: "blocked",
        href: `/tasks/task-blocked-${index}`,
        updatedAt: null,
        goalId: supervisor.goalId,
        goalTitle: supervisor.title,
        goalStatus: "active",
        taskId: `task-blocked-${index}`,
        assignedTo: "qa-agent",
        liveBlocking: true,
      },
      {
        id: `decision-${index}`,
        title: `Decision ${index}`,
        sourceType: "decision" as const,
        status: "pending",
        href: `/decisions/decision-${index}`,
        updatedAt: null,
        goalId: supervisor.goalId,
        goalTitle: supervisor.title,
        goalStatus: "active",
        taskId: null,
        assignedTo: null,
        liveBlocking: true,
      },
    ]);

    const model = buildOperationsMapModel({ supervisors, tasks, criticalItems });
    const topology = buildOperationsTopology(model);
    const nodesById = new Map(topology.nodes.map((node) => [node.id, node]));

    for (const edge of topology.edges.filter((candidate) => candidate.from.startsWith("goal-"))) {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      expect(from).toBeTruthy();
      expect(to).toBeTruthy();
      expect(to!.x).toBeGreaterThan(150);
      expect(to!.x).toBeLessThan(850);
      expect(Math.hypot(to!.x - from!.x, to!.y - from!.y)).toBeLessThanOrEqual(260);
    }
  });

  it("keeps crowded linked items readable without reverting to side-stack lanes", () => {
    const model = buildOperationsMapModel({
      supervisors: [
        {
          goalId: "goal-1",
          title: "Crowded goal",
          threadId: null,
          lastActivityAt: null,
          state: "running",
        },
      ],
      tasks: [],
      criticalItems: Array.from({ length: 6 }, (_, index) => ({
        id: `critical-${index}`,
        title: `Critical item ${index}`,
        sourceType: "task" as const,
        status: index % 2 === 0 ? "failed" : "unresolvable",
        href: `/tasks/critical-${index}`,
        updatedAt: null,
        goalId: "goal-1",
        goalTitle: "Crowded goal",
        goalStatus: "active",
        taskId: `critical-${index}`,
        assignedTo: "dev-agent",
        liveBlocking: true,
      })),
    });

    const topology = buildOperationsTopology(model);
    const goal = topology.nodes.find((node) => node.kind === "goal");
    const taskNodes = topology.nodes.filter((node) => node.kind !== "hive" && node.kind !== "goal");

    expect(goal).toBeTruthy();
    expect(new Set(taskNodes.map((node) => Math.round(node.x))).size).toBeGreaterThan(1);

    for (const task of taskNodes) {
      expect(Math.hypot(task.x - goal!.x, task.y - goal!.y)).toBeLessThanOrEqual(330);
    }

    for (let a = 0; a < taskNodes.length; a += 1) {
      for (let b = a + 1; b < taskNodes.length; b += 1) {
        const xDistance = Math.abs(taskNodes[a].x - taskNodes[b].x);
        const yDistance = Math.abs(taskNodes[a].y - taskNodes[b].y);
        expect(xDistance >= 172 || yDistance >= 82).toBe(true);
      }
    }
  });

  it("connects hive to goals and goals to active agents, blockers, and history nodes", () => {
    const model = buildOperationsMapModel({
      supervisors: [
        {
          goalId: "goal-1",
          title: "Build the operations map",
          threadId: null,
          lastActivityAt: null,
          state: "running",
        },
        {
          goalId: "goal-idle",
          title: "Quiet supervised goal",
          threadId: null,
          lastActivityAt: null,
          state: "idle",
        },
      ],
      tasks: [
        {
          id: "task-a",
          title: "Render relationship view",
          assignedTo: "dev-agent",
          startedAt: null,
          modelUsed: null,
          status: "active",
          goalId: "goal-1",
          goalTitle: "Build the operations map",
        },
      ],
      criticalItems: [
        {
          id: "task-blocked",
          title: "Needs owner context",
          sourceType: "task",
          status: "blocked",
          href: "/tasks/task-blocked",
          updatedAt: null,
          goalId: "goal-1",
          goalTitle: "Build the operations map",
          goalStatus: "active",
          taskId: "task-blocked",
          assignedTo: "qa-agent",
          liveBlocking: true,
        },
        {
          id: "task-old-fail",
          title: "Historical failure",
          sourceType: "task",
          status: "failed",
          href: "/tasks/task-old-fail",
          updatedAt: null,
          goalId: "goal-done",
          goalTitle: "Shipped goal",
          goalStatus: "achieved",
          taskId: "task-old-fail",
          assignedTo: "dev-agent",
          liveBlocking: false,
        },
      ],
    });

    const topology = buildOperationsTopology(model);
    const edgeKinds = topology.edges.map((edge) => edge.kind);

    expect(topology.nodes.some((node) => node.kind === "hive")).toBe(true);
    expect(topology.nodes.filter((node) => node.kind === "goal")).toHaveLength(3);
    expect(topology.nodes.some((node) => node.kind === "agent" && node.active)).toBe(true);
    expect(topology.nodes.some((node) => node.kind === "critical-task" && node.liveBlocking)).toBe(true);
    expect(topology.nodes.some((node) => node.state === "history" && !node.liveBlocking)).toBe(true);
    expect(edgeKinds).toContain("goal");
    expect(edgeKinds).toContain("active");
    expect(edgeKinds).toContain("blocking");
    expect(edgeKinds).toContain("history");
  });

  it("keeps topology nodes visibly separated instead of clamping them into side stacks", () => {
    const criticalItems = Array.from({ length: 8 }, (_, index) => ({
      id: `task-blocked-${index}`,
      title: `Blocked task ${index}`,
      sourceType: "task" as const,
      status: index % 2 === 0 ? "failed" : "unresolvable",
      href: `/tasks/task-blocked-${index}`,
      updatedAt: null,
      goalId: index < 4 ? "goal-1" : "goal-2",
      goalTitle: index < 4 ? "First active goal" : "Second active goal",
      goalStatus: "active",
      taskId: `task-blocked-${index}`,
      assignedTo: index % 2 === 0 ? "dev-agent" : "qa",
      liveBlocking: true,
    }));
    const model = buildOperationsMapModel({
      supervisors: [
        { goalId: "goal-1", title: "First active goal", threadId: null, lastActivityAt: null, state: "running" },
        { goalId: "goal-2", title: "Second active goal", threadId: null, lastActivityAt: null, state: "waking" },
      ],
      tasks: [],
      criticalItems,
    });

    const topology = buildOperationsTopology(model);
    const occupied = new Set<string>();
    for (const node of topology.nodes) {
      const key = `${Math.round(node.x / 12)}:${Math.round(node.y / 12)}`;
      expect(occupied.has(key)).toBe(false);
      occupied.add(key);
    }
  });

  it("keeps achieved-goal history on the goal branch instead of a detached side stack", () => {
    const model = buildOperationsMapModel({
      supervisors: [],
      tasks: [],
      criticalItems: [
        {
          id: "task-old-fail",
          title: "Old completed-goal failure",
          sourceType: "task",
          status: "failed",
          href: "/tasks/task-old-fail",
          updatedAt: null,
          goalId: "goal-done",
          goalTitle: "Already shipped goal",
          goalStatus: "achieved",
          taskId: "task-old-fail",
          assignedTo: "dev-agent",
          liveBlocking: false,
        },
      ],
    });

    const topology = buildOperationsTopology(model);
    const goalNode = topology.nodes.find((node) => node.id === "goal-goal-done");
    const historyNode = topology.nodes.find((node) => node.id === "goal-goal-done-history-task-old-fail");

    expect(goalNode).toBeTruthy();
    expect(historyNode).toBeTruthy();
    expect(historyNode!.state).toBe("history");
    expect(historyNode!.x - goalNode!.x).toBeLessThanOrEqual(520);
  });
});
