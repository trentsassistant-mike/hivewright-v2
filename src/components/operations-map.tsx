"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type SupervisorState = "running" | "waking" | "idle" | "unknown";
type NodeState =
  | "active"
  | "warming"
  | "idle"
  | "parked"
  | "failed"
  | "unresolvable"
  | "decision"
  | "escalation"
  | "complete"
  | "history"
  | "unknown";

interface SupervisorNode {
  goalId: string;
  goalShortId?: string;
  title: string;
  threadId: string | null;
  lastActivityAt: string | null;
  state: SupervisorState;
}

interface ActiveTask {
  id: string;
  title: string;
  assignedTo: string;
  status?: string;
  startedAt: string | null;
  modelUsed: string | null;
  goalId?: string | null;
  goalTitle?: string | null;
}

interface CriticalItem {
  id: string;
  title: string;
  sourceType: "task" | "decision";
  status: string;
  href: string;
  updatedAt: string | null;
  goalId?: string | null;
  goalTitle?: string | null;
  goalStatus?: string | null;
  taskId?: string | null;
  assignedTo?: string | null;
  liveBlocking?: boolean;
}

export interface RelationshipTaskNode {
  id: string;
  sourceTaskId: string | null;
  kind: "agent" | "critical-task" | "decision";
  label: string;
  sublabel: string;
  href: string;
  state: NodeState;
  liveBlocking: boolean;
  active: boolean;
}

export interface GoalCluster {
  id: string;
  goalId: string | null;
  goalTitle: string;
  goalStatus: string | null;
  goalHref: string | null;
  supervisorState: NodeState;
  supervisorSublabel: string;
  tasks: RelationshipTaskNode[];
  liveCriticalCount: number;
  historicalFailureCount: number;
}

export interface OperationsMapModel {
  clusters: GoalCluster[];
  totalLiveCritical: number;
  totalHistoricalFailures: number;
  hasActivity: boolean;
}

export type OperationsTopologyNodeKind = "hive" | "goal" | RelationshipTaskNode["kind"];
export type OperationsTopologyEdgeKind = "goal" | "active" | "blocking" | "history";

export interface OperationsTopologyNode {
  id: string;
  kind: OperationsTopologyNodeKind;
  label: string;
  sublabel: string;
  href: string | null;
  state: NodeState;
  x: number;
  y: number;
  liveBlocking: boolean;
  active: boolean;
}

export interface OperationsTopologyEdge {
  id: string;
  from: string;
  to: string;
  kind: OperationsTopologyEdgeKind;
}

export interface OperationsTopology {
  nodes: OperationsTopologyNode[];
  edges: OperationsTopologyEdge[];
  width: number;
  height: number;
}

const ORPHAN_CLUSTER_ID = "__orphan__";
const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 620;
const GRAPH_CENTER_X = GRAPH_WIDTH / 2;
const GRAPH_CENTER_Y = GRAPH_HEIGHT / 2;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed with ${response.status}`);
  return response.json() as Promise<T>;
}

function formatRelative(value: string | null): string {
  if (!value) return "no timestamp";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "invalid timestamp";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function stateLabel(state: NodeState): string {
  switch (state) {
    case "active":
      return "Active";
    case "warming":
      return "Waking";
    case "idle":
      return "Idle";
    case "parked":
      return "Parked";
    case "failed":
      return "Failed";
    case "unresolvable":
      return "Unresolvable";
    case "decision":
      return "Decision";
    case "escalation":
      return "Escalation";
    case "complete":
      return "Complete";
    case "history":
      return "History";
    default:
      return "Unknown";
  }
}

function supervisorState(state: SupervisorState): NodeState {
  if (state === "running") return "active";
  if (state === "waking") return "warming";
  if (state === "idle") return "idle";
  return "unknown";
}

function taskNodeState(status: string | undefined): NodeState {
  if (status === "blocked") return "parked";
  if (status === "failed") return "failed";
  if (status === "unresolvable") return "unresolvable";
  return "active";
}

function criticalItemState(item: CriticalItem): NodeState {
  if (item.sourceType === "decision") {
    return item.status === "ea_review" ? "escalation" : "decision";
  }
  return taskNodeState(item.status);
}

function truncateLabel(value: string, max = 32): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function buildOperationsMapModel(params: {
  supervisors: SupervisorNode[];
  tasks: ActiveTask[];
  criticalItems?: CriticalItem[];
}): OperationsMapModel {
  const supervisors = params.supervisors;
  const tasks = params.tasks;
  const criticalItems = params.criticalItems ?? [];

  const clusterMap = new Map<string, GoalCluster>();

  function getCluster(args: {
    goalId: string | null;
    goalTitle: string | null;
    goalStatus: string | null;
  }): GoalCluster {
    const key = args.goalId ?? ORPHAN_CLUSTER_ID;
    const existing = clusterMap.get(key);
    if (existing) {
      if (existing.goalStatus === null && args.goalStatus) {
        existing.goalStatus = args.goalStatus;
      }
      if (existing.goalTitle === "Direct work (no goal)" && args.goalTitle && args.goalId) {
        existing.goalTitle = args.goalTitle;
      }
      return existing;
    }

    const cluster: GoalCluster = {
      id: key,
      goalId: args.goalId,
      goalTitle: args.goalId ? (args.goalTitle ?? "Untitled goal") : "Direct work (no goal)",
      goalStatus: args.goalStatus,
      goalHref: args.goalId ? `/goals/${args.goalId}` : null,
      supervisorState: "unknown",
      supervisorSublabel: "No supervisor session",
      tasks: [],
      liveCriticalCount: 0,
      historicalFailureCount: 0,
    };
    clusterMap.set(key, cluster);
    return cluster;
  }

  // Seed clusters with all known supervisors so even idle goals appear.
  for (const supervisor of supervisors) {
    const cluster = getCluster({
      goalId: supervisor.goalId,
      goalTitle: supervisor.title,
      goalStatus: "active",
    });
    cluster.supervisorState = supervisorState(supervisor.state);
    cluster.supervisorSublabel = `Supervisor ${stateLabel(supervisorState(supervisor.state)).toLowerCase()} · ${formatRelative(supervisor.lastActivityAt)}`;
  }

  // Active tasks (live agents) — bind to goal cluster (or orphan).
  for (const task of tasks) {
    const cluster = getCluster({
      goalId: task.goalId ?? null,
      goalTitle: task.goalTitle ?? null,
      goalStatus: task.goalId ? "active" : null,
    });
    cluster.tasks.push({
      id: `agent-${task.id}`,
      sourceTaskId: task.id,
      kind: "agent",
      label: truncateLabel(task.assignedTo || "Agent", 22),
      sublabel: truncateLabel(task.title, 60),
      href: `/tasks/${task.id}`,
      state: taskNodeState(task.status),
      liveBlocking: false,
      active: true,
    });
  }

  // Critical items — placed under their linked goal so the relationship is visible.
  for (const item of criticalItems) {
    const isHistorical = item.liveBlocking === false;
    if (isHistorical && item.sourceType === "task") {
      const cluster = getCluster({
        goalId: item.goalId ?? null,
        goalTitle: item.goalTitle ?? null,
        goalStatus: item.goalStatus ?? null,
      });
      cluster.historicalFailureCount += 1;
      // Still surface a node, but as history so it never lights up critical.
      cluster.tasks.push({
        id: `history-${item.id}`,
        sourceTaskId: item.taskId ?? item.id,
        kind: "critical-task",
        label: truncateLabel(item.assignedTo ?? item.title, 22),
        sublabel: `${stateLabel(taskNodeState(item.status))} · history · ${formatRelative(item.updatedAt)}`,
        href: item.href,
        state: "history",
        liveBlocking: false,
        active: false,
      });
      continue;
    }
    if (isHistorical) {
      // Historical decisions should not appear as live blockers or linger as
      // stale topology nodes once the linked goal has already finished.
      continue;
    }

    const cluster = getCluster({
      goalId: item.goalId ?? null,
      goalTitle: item.goalTitle ?? null,
      goalStatus: item.goalStatus ?? null,
    });
    const state = criticalItemState(item);
    cluster.tasks.push({
      id: `${item.sourceType}-${item.id}`,
      sourceTaskId: item.sourceType === "task" ? (item.taskId ?? item.id) : null,
      kind: item.sourceType === "decision" ? "decision" : "critical-task",
      label: truncateLabel(item.assignedTo ?? item.title, 22),
      sublabel: `${stateLabel(state)} · ${formatRelative(item.updatedAt)}`,
      href: item.href,
      state,
      liveBlocking: true,
      active: false,
    });
    cluster.liveCriticalCount += 1;
  }

  const clusters = Array.from(clusterMap.values()).sort((a, b) => {
    if (a.id === ORPHAN_CLUSTER_ID) return 1;
    if (b.id === ORPHAN_CLUSTER_ID) return -1;
    if (a.liveCriticalCount !== b.liveCriticalCount) {
      return b.liveCriticalCount - a.liveCriticalCount;
    }
    const aActive = a.tasks.some((task) => task.active);
    const bActive = b.tasks.some((task) => task.active);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return a.goalTitle.localeCompare(b.goalTitle);
  });

  const totalLiveCritical = clusters.reduce((acc, c) => acc + c.liveCriticalCount, 0);
  const totalHistoricalFailures = clusters.reduce((acc, c) => acc + c.historicalFailureCount, 0);
  const hasActivity = clusters.length > 0;

  return {
    clusters,
    totalLiveCritical,
    totalHistoricalFailures,
    hasActivity,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function taskEdgeKind(task: RelationshipTaskNode): OperationsTopologyEdgeKind {
  if (task.liveBlocking) return "blocking";
  if (task.active) return "active";
  if (task.state === "history") return "history";
  return "goal";
}

function clusterEdgeKind(cluster: GoalCluster): OperationsTopologyEdgeKind {
  if (cluster.liveCriticalCount > 0) return "blocking";
  if (cluster.tasks.some((task) => task.active)) return "active";
  if (cluster.historicalFailureCount > 0) return "history";
  return "goal";
}

function goalPosition(index: number, count: number): { x: number; y: number; side: -1 | 1 } {
  if (count === 1) {
    return { x: GRAPH_CENTER_X - 170, y: GRAPH_CENTER_Y, side: -1 };
  }

  const angle = -Math.PI / 2 + ((Math.PI * 2) / count) * index;
  const x = GRAPH_CENTER_X + Math.cos(angle) * 310;
  const y = GRAPH_CENTER_Y + Math.sin(angle) * 205;
  const side: -1 | 1 = x < GRAPH_CENTER_X || (x === GRAPH_CENTER_X && index % 2 === 0) ? -1 : 1;

  return {
    x: clamp(x, 190, GRAPH_WIDTH - 190),
    y: clamp(y, 118, GRAPH_HEIGHT - 118),
    side,
  };
}

// Tasks fan OUTWARD from their goal, away from the core. For the common
// 1-3-task case we use a clean column (the dominant layout in the user's
// reference diagram). For 4+ tasks we fall back to the established offset
// table — its wider distribution (including some "behind the goal" slots)
// is what keeps crowded goals readable per the separation invariant.
const TASK_BASE_X = 175;
const TASK_SLOTS_CROWDED: Array<{ radial: number; y: number }> = [
  { radial: 1, y: -112 },
  { radial: -0.72, y: 0 },
  { radial: 1, y: 112 },
  { radial: 0, y: -214 },
  { radial: 0, y: 214 },
  { radial: -1, y: -112 },
  { radial: -1, y: 112 },
  { radial: 1.8, y: 0 },
  { radial: -1.8, y: 0 },
];

function taskPosition(args: {
  goalX: number;
  goalY: number;
  side: -1 | 1;
  taskIndex: number;
  taskCount: number;
}): { x: number; y: number } {
  if (args.taskCount === 1) {
    return {
      x: clamp(args.goalX + args.side * TASK_BASE_X, 158, GRAPH_WIDTH - 158),
      y: args.goalY,
    };
  }
  if (args.taskCount === 2) {
    const dy = args.taskIndex === 0 ? -100 : 100;
    return {
      x: clamp(args.goalX + args.side * TASK_BASE_X, 158, GRAPH_WIDTH - 158),
      y: clamp(args.goalY + dy, 72, GRAPH_HEIGHT - 72),
    };
  }
  if (args.taskCount === 3) {
    const dy = args.taskIndex === 0 ? -120 : args.taskIndex === 1 ? 0 : 120;
    return {
      x: clamp(args.goalX + args.side * TASK_BASE_X, 158, GRAPH_WIDTH - 158),
      y: clamp(args.goalY + dy, 72, GRAPH_HEIGHT - 72),
    };
  }
  const offset = TASK_SLOTS_CROWDED[args.taskIndex % TASK_SLOTS_CROWDED.length];
  const ring = Math.floor(args.taskIndex / TASK_SLOTS_CROWDED.length);
  const spacing = 220;
  return {
    x: clamp(
      args.goalX + args.side * offset.radial * (spacing + ring * 54),
      158,
      GRAPH_WIDTH - 158,
    ),
    y: clamp(args.goalY + offset.y + ring * 96, 72, GRAPH_HEIGHT - 72),
  };
}

export function buildOperationsTopology(model: OperationsMapModel): OperationsTopology {
  const nodes: OperationsTopologyNode[] = [
    {
      id: "hive",
      kind: "hive",
      label: "Hive",
      sublabel: "Operations core",
      href: null,
      state: "active",
      x: GRAPH_CENTER_X,
      y: GRAPH_CENTER_Y,
      liveBlocking: model.totalLiveCritical > 0,
      active: true,
    },
  ];
  const edges: OperationsTopologyEdge[] = [];

  model.clusters.forEach((cluster, index) => {
    const { x: goalX, y: goalY, side } = goalPosition(index, model.clusters.length);
    const goalNodeId = `goal-${cluster.id}`;
    const activeByTaskId = new Map(
      cluster.tasks
        .filter((task) => task.active && task.sourceTaskId)
        .map((task) => [task.sourceTaskId, `${goalNodeId}-${task.id}`]),
    );

    nodes.push({
      id: goalNodeId,
      kind: "goal",
      label: truncateLabel(cluster.goalTitle, 42),
      sublabel: cluster.supervisorSublabel,
      href: cluster.goalHref,
      state: cluster.supervisorState,
      x: goalX,
      y: goalY,
      liveBlocking: cluster.liveCriticalCount > 0,
      active: cluster.tasks.some((task) => task.active),
    });
    edges.push({
      id: `edge-hive-${cluster.id}`,
      from: "hive",
      to: goalNodeId,
      kind: clusterEdgeKind(cluster),
    });

    cluster.tasks.forEach((task, taskIndex) => {
      const relatedActiveNodeId = task.sourceTaskId ? activeByTaskId.get(task.sourceTaskId) : undefined;
      const chainsFromActiveAgent = Boolean(!task.active && relatedActiveNodeId);
      const { x: taskX, y: taskY } = taskPosition({
        goalX,
        goalY,
        side,
        taskIndex,
        taskCount: cluster.tasks.length,
      });
      const taskNodeId = `${goalNodeId}-${task.id}`;
      nodes.push({
        id: taskNodeId,
        kind: task.kind,
        label: task.label,
        sublabel: task.sublabel,
        href: task.href,
        state: task.state,
        x: taskX,
        y: taskY,
        liveBlocking: task.liveBlocking,
        active: task.active,
      });
      edges.push({
        id: chainsFromActiveAgent
          ? `edge-${relatedActiveNodeId!.replace(`${goalNodeId}-`, "")}-${task.id}`
          : `edge-${cluster.id}-${task.id}`,
        from: chainsFromActiveAgent ? relatedActiveNodeId! : goalNodeId,
        to: taskNodeId,
        kind: taskEdgeKind(task),
      });
    });
  });

  return { nodes, edges, width: GRAPH_WIDTH, height: GRAPH_HEIGHT };
}

function sourceLabel(hasError: boolean, count: number, noun: string) {
  if (hasError) return `${noun} unavailable`;
  return `${count} ${noun}`;
}

interface OperationsMapProps {
  hiveId: string;
  hiveName: string;
}

export function OperationsMap({ hiveId, hiveName }: OperationsMapProps) {
  const supervisorsQuery = useQuery({
    queryKey: ["operations-map", "active-supervisors", hiveId],
    queryFn: async () => {
      const payload = await fetchJson<{ data: SupervisorNode[] }>(`/api/active-supervisors?hiveId=${hiveId}`);
      return payload.data ?? [];
    },
  });
  const tasksQuery = useQuery({
    queryKey: ["operations-map", "active-tasks", hiveId],
    queryFn: async () => {
      const payload = await fetchJson<{ tasks: ActiveTask[] }>(`/api/active-tasks?hiveId=${hiveId}`);
      return payload.tasks ?? [];
    },
  });
  const criticalQuery = useQuery({
    queryKey: ["operations-map", "critical-items", hiveId],
    queryFn: async () => {
      const payload = await fetchJson<{ criticalItems?: CriticalItem[] }>(
        `/api/active-tasks?hiveId=${hiveId}&includeCritical=true`,
      );
      return payload.criticalItems ?? [];
    },
  });

  const supervisors = supervisorsQuery.data ?? [];
  const tasks = tasksQuery.data ?? [];
  const criticalItems = criticalQuery.data ?? [];
  const model = buildOperationsMapModel({ supervisors, tasks, criticalItems });
  const loading = supervisorsQuery.isLoading || tasksQuery.isLoading || criticalQuery.isLoading;
  const hasError = Boolean(supervisorsQuery.error || tasksQuery.error || criticalQuery.error);

  return (
    <Card
      className="border-white/[0.06] bg-[#14161A] py-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_8px_24px_rgba(0,0,0,0.4)]"
      aria-labelledby="operations-map-title"
    >
      <CardHeader className="gap-3 border-b border-white/[0.06] px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--honey-300)]/80">
              Operations map
            </p>
            <CardTitle
              id="operations-map-title"
              className="mt-1 text-[20px] leading-[26px] font-semibold text-[#F2EBDD]"
            >
              {hiveName}
            </CardTitle>
            <p className="mt-1 text-[13px] leading-[18px] text-[#B8B0A0]">
              Goals, agents, and unresolved blockers wired into a single relationship graph.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:min-w-[360px]">
            <SourcePill label={sourceLabel(Boolean(supervisorsQuery.error), supervisors.length, "supervisors")} />
            <SourcePill label={sourceLabel(Boolean(tasksQuery.error), tasks.length, "agents")} />
            <SourcePill
              label={
                criticalQuery.error
                  ? "critical unavailable"
                  : `${model.totalLiveCritical} live critical${
                      model.totalHistoricalFailures > 0 ? ` · ${model.totalHistoricalFailures} history` : ""
                    }`
              }
            />
          </div>
        </div>
        {hasError ? (
          <p className="text-[13px] leading-[18px] text-[#D4A398]">
            Some feeds did not load. Available sources remain visible while the dashboard retries.
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-5">
        <OperationsMapView model={model} loading={loading} />
      </CardContent>
    </Card>
  );
}

export function OperationsMapView({ model, loading }: { model: OperationsMapModel; loading: boolean }) {
  if (loading && !model.hasActivity) {
    return (
      <p className="rounded-[12px] border border-white/[0.06] bg-[#0F1114] px-4 py-3 text-[13px] text-[#B8B0A0]">
        Loading operations feeds…
      </p>
    );
  }
  if (!model.hasActivity) {
    return (
      <p className="rounded-[12px] border border-dashed border-[var(--honey-700)]/40 bg-[#0F1114] px-4 py-4 text-[13px] text-[#B8B0A0]">
        No live supervisors, active agents, or critical items are available for this hive yet.
      </p>
    );
  }

  return <OperationsTopologyView topology={buildOperationsTopology(model)} model={model} />;
}

function bezierPath(ax: number, ay: number, bx: number, by: number): string {
  const midX = (ax + bx) / 2;
  return `M${ax},${ay} C ${midX},${ay} ${midX},${by} ${bx},${by}`;
}

function hexPoints(cx: number, cy: number, r: number): string {
  // Flat-top hex, matching the brand mark and the user-pinned topology layout.
  const a = r * 0.866;
  const h = r / 2;
  return [
    [cx + r, cy],
    [cx + h, cy + a],
    [cx - h, cy + a],
    [cx - r, cy],
    [cx - h, cy - a],
    [cx + h, cy - a],
  ]
    .map((p) => p.join(","))
    .join(" ");
}

interface NodeVisual {
  r: number;
  bevelFill: string;
  faceFill: string;
  ringStroke: string;
  ringStrokeOpacity: number;
  glow: "core" | "honey" | "ember" | "sage" | "none";
  labelTone: string;
  sublabelTone: string;
  innerGlyphStroke: string;
  innerGlyphOpacity: number;
}

function nodeVisual(node: OperationsTopologyNode): NodeVisual {
  if (node.kind === "hive") {
    return {
      r: 42,
      bevelFill: "url(#om-bevel)",
      faceFill: "url(#om-face-core)",
      ringStroke: "#FFE89A",
      ringStrokeOpacity: 0.85,
      glow: "core",
      labelTone: "#FFE89A",
      sublabelTone: "#B8B0A0",
      innerGlyphStroke: "#FFE89A",
      innerGlyphOpacity: 1,
    };
  }
  if (node.liveBlocking || node.state === "failed" || node.state === "unresolvable") {
    return {
      r: node.kind === "goal" ? 30 : 26,
      bevelFill: "url(#om-bevel-ember)",
      faceFill: "url(#om-face-ember)",
      ringStroke: "#F8A08A",
      ringStrokeOpacity: 0.78,
      glow: "ember",
      labelTone: "#F2EBDD",
      sublabelTone: "#D4A398",
      innerGlyphStroke: "#FFE2D4",
      innerGlyphOpacity: 0.85,
    };
  }
  if (node.state === "history") {
    return {
      r: node.kind === "goal" ? 26 : 20,
      bevelFill: "url(#om-bevel-idle)",
      faceFill: "url(#om-face-history)",
      ringStroke: "rgba(184,137,90,0.32)",
      ringStrokeOpacity: 1,
      glow: "none",
      labelTone: "#6F6A60",
      sublabelTone: "#4A4640",
      innerGlyphStroke: "rgba(184,137,90,0.6)",
      innerGlyphOpacity: 0.45,
    };
  }
  if (node.state === "decision" || node.state === "escalation") {
    return {
      r: node.kind === "goal" ? 30 : 26,
      bevelFill: "url(#om-bevel-sage)",
      faceFill: "url(#om-face-sage)",
      ringStroke: "#C7D8C2",
      ringStrokeOpacity: 0.7,
      glow: "sage",
      labelTone: "#F2EBDD",
      sublabelTone: "#A4B8A4",
      innerGlyphStroke: "#E2EBDF",
      innerGlyphOpacity: 0.85,
    };
  }
  if (node.active) {
    return {
      r: node.kind === "goal" ? 32 : 26,
      bevelFill: "url(#om-bevel)",
      faceFill: "url(#om-face-active)",
      ringStroke: "#FFE89A",
      ringStrokeOpacity: 0.7,
      glow: "honey",
      labelTone: "#FFD68A",
      sublabelTone: "#B8B0A0",
      innerGlyphStroke: "#FFE89A",
      innerGlyphOpacity: 0.85,
    };
  }
  return {
    r: node.kind === "goal" ? 28 : 22,
    bevelFill: "url(#om-bevel-idle)",
    faceFill: "url(#om-face-idle)",
    ringStroke: "rgba(255,184,54,0.22)",
    ringStrokeOpacity: 1,
    glow: "none",
    labelTone: "#B8B0A0",
    sublabelTone: "#6F6A60",
    innerGlyphStroke: "rgba(184,137,90,0.6)",
    innerGlyphOpacity: 0.55,
  };
}

function glowFilter(glow: NodeVisual["glow"]): string | undefined {
  switch (glow) {
    case "core":
      return "drop-shadow(0 0 18px rgba(255,184,54,0.55))";
    case "honey":
      return "drop-shadow(0 0 12px rgba(255,184,54,0.45))";
    case "ember":
      return "drop-shadow(0 0 14px rgba(194,74,44,0.55))";
    case "sage":
      return "drop-shadow(0 0 10px rgba(126,155,126,0.40))";
    default:
      return undefined;
  }
}

function CoreGlyph({ cx, cy, stroke }: { cx: number; cy: number; stroke: string }) {
  // Honeycomb "H" mark, matching the brand mark.
  return (
    <g stroke={stroke} strokeWidth="2.5" fill="none" strokeLinecap="round">
      <line x1={cx - 9} y1={cy - 11} x2={cx - 9} y2={cy + 11} />
      <line x1={cx + 9} y1={cy - 11} x2={cx + 9} y2={cy + 11} />
      <line x1={cx - 9} y1={cy} x2={cx + 9} y2={cy} />
    </g>
  );
}

function OperationsTopologyView({
  topology,
  model,
}: {
  topology: OperationsTopology;
  model: OperationsMapModel;
}) {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  const hive = topology.nodes.find((node) => node.kind === "hive");
  return (
    <div
      className="op-map-topology relative min-h-[540px] overflow-hidden rounded-[12px] border border-white/[0.06] bg-[#0B0C0E]"
      data-testid="operations-map-topology"
      data-live-critical={model.totalLiveCritical > 0 ? "true" : "false"}
    >
      <svg
        className="block h-full min-h-[540px] w-full"
        data-testid="operations-map-svg"
        preserveAspectRatio="xMidYMid meet"
        style={{ height: topology.height }}
        viewBox={`0 0 ${topology.width} ${topology.height}`}
        role="img"
        aria-label="Operations relationship map"
      >
        <defs>
          {/* Bevel rings — outer hex */}
          <linearGradient id="om-bevel" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FFE89A" />
            <stop offset="50%" stopColor="#E59A1B" />
            <stop offset="100%" stopColor="#5C3206" />
          </linearGradient>
          <linearGradient id="om-bevel-idle" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgba(184,137,90,0.55)" />
            <stop offset="100%" stopColor="rgba(40,30,18,0.85)" />
          </linearGradient>
          <linearGradient id="om-bevel-ember" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FFC59A" />
            <stop offset="50%" stopColor="#C24A2C" />
            <stop offset="100%" stopColor="#3F140A" />
          </linearGradient>
          <linearGradient id="om-bevel-sage" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#C7D8C2" />
            <stop offset="50%" stopColor="#7E9B7E" />
            <stop offset="100%" stopColor="#2A3A2A" />
          </linearGradient>
          {/* Inner faces */}
          <linearGradient id="om-face-active" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFD56A" />
            <stop offset="22%" stopColor="#F0A416" />
            <stop offset="50%" stopColor="#9A5400" />
            <stop offset="78%" stopColor="#F0A416" />
            <stop offset="100%" stopColor="#FFD56A" />
          </linearGradient>
          <linearGradient id="om-face-core" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFE89A" />
            <stop offset="30%" stopColor="#FFB836" />
            <stop offset="55%" stopColor="#B86E08" />
            <stop offset="80%" stopColor="#FFB836" />
            <stop offset="100%" stopColor="#FFE89A" />
          </linearGradient>
          <linearGradient id="om-face-idle" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(229,154,27,0.16)" />
            <stop offset="50%" stopColor="rgba(40,28,12,0.65)" />
            <stop offset="100%" stopColor="rgba(229,154,27,0.16)" />
          </linearGradient>
          <linearGradient id="om-face-ember" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F8A08A" />
            <stop offset="22%" stopColor="#D55B3A" />
            <stop offset="50%" stopColor="#5C1E10" />
            <stop offset="78%" stopColor="#D55B3A" />
            <stop offset="100%" stopColor="#F8A08A" />
          </linearGradient>
          <linearGradient id="om-face-sage" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#C7D8C2" />
            <stop offset="30%" stopColor="#7E9B7E" />
            <stop offset="55%" stopColor="#1F2D1F" />
            <stop offset="80%" stopColor="#7E9B7E" />
            <stop offset="100%" stopColor="#C7D8C2" />
          </linearGradient>
          <linearGradient id="om-face-history" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(184,137,90,0.10)" />
            <stop offset="50%" stopColor="rgba(40,38,30,0.55)" />
            <stop offset="100%" stopColor="rgba(184,137,90,0.10)" />
          </linearGradient>
          {/* Atmospheric core glow */}
          <radialGradient id="om-core-glow" cx="0.5" cy="0.5" r="0.6">
            <stop offset="0%" stopColor="#FFB836" stopOpacity="0.45" />
            <stop offset="60%" stopColor="#E59A1B" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
          {/* Subtle hex-grid texture, brass at low opacity */}
          <pattern id="om-hexgrid-bg" x="0" y="0" width="44" height="50" patternUnits="userSpaceOnUse">
            <path
              d="M11 1 L33 1 L44 25 L33 49 L11 49 L0 25 Z"
              fill="none"
              stroke="rgba(184,137,90,0.07)"
              strokeWidth="0.8"
            />
          </pattern>
        </defs>

        <rect width={topology.width} height={topology.height} fill="url(#om-hexgrid-bg)" />
        {hive ? <circle cx={hive.x} cy={hive.y} r={170} fill="url(#om-core-glow)" /> : null}

        {/* Edges first so node hexes paint on top. */}
        {topology.edges.map((edge) => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          if (!from || !to) return null;
          const path = bezierPath(from.x, from.y, to.x, to.y);
          return (
            <g key={edge.id}>
              <path
                id={edge.id}
                d={path}
                data-testid="op-map-edge"
                data-edge-from={edge.from}
                data-edge-to={edge.to}
                data-edge-kind={edge.kind}
                data-edge-id={edge.id}
                className={cn(
                  "op-map-edge",
                  edge.kind === "active" && "op-map-edge--active",
                  edge.kind === "blocking" && "op-map-edge--blocking",
                  edge.kind === "history" && "op-map-edge--history",
                )}
                fill="none"
                pathLength={1}
              />
            </g>
          );
        })}

        {/* Nodes */}
        {topology.nodes.map((node) => (
          <TopologyNode key={node.id} node={node} />
        ))}
      </svg>
      <div className="border-t border-white/[0.06] bg-black/30 px-5 py-3 text-[12px] tracking-[0.01em] text-[#B8B0A0]">
        <span className="font-semibold text-[#F2EBDD]">Relationship chain</span>
        <span className="mx-2 text-[#6F6A60]">·</span>
        Hive to goals, goals to agents and blockers, agents to matching failures and decisions
        <span className="ml-3 text-[#F0A096]">{model.totalLiveCritical} live blockers</span>
        {model.totalHistoricalFailures > 0 ? (
          <span className="ml-3 text-[#6F6A60]">{model.totalHistoricalFailures} historical only</span>
        ) : null}
      </div>
    </div>
  );
}

function TopologyNode({ node }: { node: OperationsTopologyNode }) {
  const visual = nodeVisual(node);
  const innerR = visual.r * 0.88;
  const filter = glowFilter(visual.glow);
  // Flat-top hex bottom edge is at cy + r * 0.866; labels sit just below it.
  const hexBottom = visual.r * 0.866;
  const labelY = node.y + hexBottom + 16;
  const sublabelY = node.y + hexBottom + 30;
  const isCore = node.kind === "hive";

  const shape = (
    <g data-testid="op-map-node-anchor" style={filter ? { filter } : undefined}>
      <title>{`${node.label} — ${stateLabel(node.state)}${node.sublabel ? ` · ${node.sublabel}` : ""}`}</title>
      <polygon
        points={hexPoints(node.x, node.y, visual.r)}
        fill={visual.bevelFill}
        stroke={visual.ringStroke}
        strokeWidth={isCore || node.active || node.liveBlocking ? 0.9 : 1}
        strokeOpacity={visual.ringStrokeOpacity}
      />
      <polygon
        points={hexPoints(node.x, node.y, innerR)}
        fill={visual.faceFill}
        stroke="#000000"
        strokeOpacity={isCore ? 0.32 : 0.18}
        strokeWidth={0.8}
      />
      {isCore ? (
        <CoreGlyph cx={node.x} cy={node.y} stroke={visual.innerGlyphStroke} />
      ) : (
        <polygon
          points={hexPoints(node.x, node.y, Math.max(7, innerR * 0.32))}
          fill="none"
          stroke={visual.innerGlyphStroke}
          strokeOpacity={visual.innerGlyphOpacity}
          strokeWidth={1}
        />
      )}
      <text
        x={node.x}
        y={labelY}
        textAnchor="middle"
        fill={visual.labelTone}
        style={{ font: '600 11px/14px "Manrope", ui-sans-serif, system-ui, sans-serif' }}
      >
        {node.label}
      </text>
      {node.sublabel ? (
        <text
          x={node.x}
          y={sublabelY}
          textAnchor="middle"
          fill={visual.sublabelTone}
          style={{
            font: '500 9px/12px "Manrope", ui-sans-serif, system-ui, sans-serif',
            letterSpacing: "0.04em",
          }}
        >
          {node.sublabel}
        </text>
      ) : null}
    </g>
  );

  if (node.href) {
    const testId =
      node.kind === "goal"
        ? "op-map-goal-link"
        : node.kind === "decision"
          ? "op-map-decision-link"
          : "op-map-task-link";
    return (
      <a
        href={node.href}
        data-testid={testId}
        data-state={node.state}
        data-live-blocking={node.liveBlocking ? "true" : "false"}
        data-goal-id={node.kind === "goal" ? node.id.replace(/^goal-/, "") : undefined}
      >
        {shape}
      </a>
    );
  }

  return shape;
}

function SourcePill({ label }: { label: string }) {
  return (
    <span className="min-w-0 truncate rounded-md border border-white/[0.06] bg-black/30 px-2.5 py-1.5 text-center text-[11px] tabular-nums text-[#B8B0A0]">
      {label}
    </span>
  );
}
