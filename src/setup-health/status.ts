export type SetupHealthStatus =
  | "ready"
  | "needs_attention"
  | "pending"
  | "not_set_up";

export type SetupHealthRowKey =
  | "models"
  | "ea"
  | "dispatcher"
  | "connectors"
  | "schedules"
  | "memory";

export type SetupHealthRow = {
  key: SetupHealthRowKey;
  title: string;
  status: SetupHealthStatus;
  statusLabel: string;
  summary: string;
  href: string;
  hrefLabel: string;
  limitation?: string;
};

export type SetupHealthSnapshot = {
  roles: {
    total: number;
    configured: number;
  };
  ea: {
    installed: boolean;
    disabled: boolean;
    lastTested: boolean;
    hasError: boolean;
  };
  dispatcher: {
    configured: boolean;
    maxConcurrentAgents: number | null;
    openTasks: number;
  };
  connectors: {
    installed: number;
    active: number;
    tested: number;
    withErrors: number;
  };
  schedules: {
    total: number;
    enabled: number;
  };
  memory: {
    requested: boolean;
    disabled: boolean;
    embeddingConfigured: boolean;
    embeddingStatus: string | null;
    embeddingError: boolean;
  };
};

const STATUS_LABELS: Record<SetupHealthStatus, string> = {
  ready: "Ready",
  needs_attention: "Needs attention",
  pending: "Pending/not checked",
  not_set_up: "Not set up yet",
};

function row(input: Omit<SetupHealthRow, "statusLabel">): SetupHealthRow {
  return {
    ...input,
    statusLabel: STATUS_LABELS[input.status],
  };
}

export function buildSetupHealthRows(snapshot: SetupHealthSnapshot): SetupHealthRow[] {
  return [
    buildModelsRow(snapshot),
    buildEaRow(snapshot),
    buildDispatcherRow(snapshot),
    buildConnectorsRow(snapshot),
    buildSchedulesRow(snapshot),
    buildMemoryRow(snapshot),
  ];
}

function buildModelsRow(snapshot: SetupHealthSnapshot): SetupHealthRow {
  if (snapshot.roles.total === 0) {
    return row({
      key: "models",
      title: "Models",
      status: "pending",
      summary: "HiveWright has not checked the configured model catalog yet.",
      href: "/setup/models",
      hrefLabel: "Open Model Setup",
    });
  }
  if (snapshot.roles.configured < snapshot.roles.total) {
    return row({
      key: "models",
      title: "Models",
      status: "needs_attention",
      summary: "Some configured roles still need a working model choice before they can take work.",
      href: "/setup/models",
      hrefLabel: "Fix model setup",
    });
  }
  return row({
    key: "models",
    title: "Models",
    status: "ready",
    summary: "Model choices are configured and ready for role assignment.",
    href: "/setup/models",
    hrefLabel: "Review Model Setup",
  });
}

function buildEaRow(snapshot: SetupHealthSnapshot): SetupHealthRow {
  if (!snapshot.ea.installed) {
    return row({
      key: "ea",
      title: "EA",
      status: "not_set_up",
      summary: "Your EA is not connected yet. This is okay if you chose to do it later.",
      href: "/setup/connectors",
      hrefLabel: "Connect EA",
    });
  }
  if (snapshot.ea.disabled || snapshot.ea.hasError) {
    return row({
      key: "ea",
      title: "EA",
      status: "needs_attention",
      summary: "Your EA connection exists, but it needs a check before HiveWright can rely on it.",
      href: "/setup/connectors",
      hrefLabel: "Fix EA connection",
    });
  }
  if (!snapshot.ea.lastTested) {
    return row({
      key: "ea",
      title: "EA",
      status: "pending",
      summary: "Your EA is connected, but it has not been tested from this screen yet.",
      href: "/setup/connectors",
      hrefLabel: "Test EA connection",
    });
  }
  return row({
    key: "ea",
    title: "EA",
    status: "ready",
    summary: "Your EA connection is saved and has passed a recent check.",
    href: "/setup/connectors",
    hrefLabel: "Review EA connection",
  });
}

function buildDispatcherRow(snapshot: SetupHealthSnapshot): SetupHealthRow {
  if (!snapshot.dispatcher.configured) {
    return row({
      key: "dispatcher",
      title: "Work queue",
      status: "pending",
      summary: "HiveWright has not confirmed how many agents may work at once.",
      href: "/setup",
      hrefLabel: "Review setup settings",
      limitation: "There is not a dedicated queue settings page yet, so this links to global setup.",
    });
  }
  if ((snapshot.dispatcher.maxConcurrentAgents ?? 0) < 1) {
    return row({
      key: "dispatcher",
      title: "Work queue",
      status: "needs_attention",
      summary: "The work queue is configured, but the agent limit needs to be at least one.",
      href: "/setup",
      hrefLabel: "Fix queue setting",
      limitation: "There is not a dedicated queue settings page yet, so this links to global setup.",
    });
  }
  return row({
    key: "dispatcher",
    title: "Work queue",
    status: "ready",
    summary: snapshot.dispatcher.openTasks > 0
      ? "The work queue is configured and has work waiting or in progress."
      : "The work queue is configured and ready for new work.",
    href: "/tasks",
    hrefLabel: "View work queue",
  });
}

function buildConnectorsRow(snapshot: SetupHealthSnapshot): SetupHealthRow {
  if (snapshot.connectors.installed === 0) {
    return row({
      key: "connectors",
      title: "Service connections",
      status: "not_set_up",
      summary: "No extra service connections are installed. This is okay if you skipped them during setup.",
      href: "/setup/connectors",
      hrefLabel: "Add connections",
    });
  }
  if (snapshot.connectors.withErrors > 0) {
    return row({
      key: "connectors",
      title: "Service connections",
      status: "needs_attention",
      summary: "One or more service connections reported a problem during the last check.",
      href: "/setup/connectors",
      hrefLabel: "Fix connections",
    });
  }
  if (snapshot.connectors.tested < snapshot.connectors.active) {
    return row({
      key: "connectors",
      title: "Service connections",
      status: "pending",
      summary: "Some service connections are saved but have not been checked yet.",
      href: "/setup/connectors",
      hrefLabel: "Test connections",
    });
  }
  return row({
    key: "connectors",
    title: "Service connections",
    status: "ready",
    summary: "Saved service connections have passed their checks.",
    href: "/setup/connectors",
    hrefLabel: "Review connections",
  });
}

function buildSchedulesRow(snapshot: SetupHealthSnapshot): SetupHealthRow {
  if (snapshot.schedules.total === 0) {
    return row({
      key: "schedules",
      title: "Recurring work",
      status: "not_set_up",
      summary: "No recurring work is set up for this hive yet.",
      href: "/schedules",
      hrefLabel: "Set up recurring work",
    });
  }
  if (snapshot.schedules.enabled === 0) {
    return row({
      key: "schedules",
      title: "Recurring work",
      status: "not_set_up",
      summary: "Recurring work exists, but it is currently turned off.",
      href: "/schedules",
      hrefLabel: "Turn on recurring work",
    });
  }
  return row({
    key: "schedules",
    title: "Recurring work",
    status: "ready",
    summary: "Recurring work is enabled for this hive.",
    href: "/schedules",
    hrefLabel: "Review recurring work",
  });
}

function buildMemoryRow(snapshot: SetupHealthSnapshot): SetupHealthRow {
  if (!snapshot.memory.requested || snapshot.memory.disabled) {
    return row({
      key: "memory",
      title: "Memory search",
      status: "not_set_up",
      summary: "Memory search is turned off for this hive.",
      href: "/setup/embeddings",
      hrefLabel: "Set up memory search",
    });
  }
  if (!snapshot.memory.embeddingConfigured) {
    return row({
      key: "memory",
      title: "Memory search",
      status: "needs_attention",
      summary: "Memory search is on, but the memory engine still needs to be set up.",
      href: "/setup/embeddings",
      hrefLabel: "Fix memory search",
    });
  }
  if (snapshot.memory.embeddingError) {
    return row({
      key: "memory",
      title: "Memory search",
      status: "needs_attention",
      summary: "Memory search is set up, but the latest preparation run reported a problem.",
      href: "/setup/embeddings",
      hrefLabel: "Fix memory search",
    });
  }
  if (snapshot.memory.embeddingStatus === "reembedding") {
    return row({
      key: "memory",
      title: "Memory search",
      status: "pending",
      summary: "Memory search is preparing the hive's knowledge now.",
      href: "/setup/embeddings",
      hrefLabel: "Check memory progress",
    });
  }
  return row({
    key: "memory",
    title: "Memory search",
    status: "ready",
    summary: "Memory search is set up and ready to help future work use hive context.",
    href: "/memory/health",
    hrefLabel: "View memory health",
  });
}
