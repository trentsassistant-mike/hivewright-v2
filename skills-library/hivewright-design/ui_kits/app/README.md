# HiveWright App UI Kit

Pixel-fidelity recreation of the HiveWright PWA dashboard. Components are deliberately cosmetic-first: real visuals, faked behavior. Pieces are modular and can be assembled into new screens.

## Components

| File | Purpose |
|---|---|
| `Sidebar.jsx` | 240px collapsed/expanded nav rail with hex H mark + nav items |
| `TopBar.jsx` | 56px top bar — search, notifications, hive switcher |
| `KpiCard.jsx` | Marquee number + sparkline card |
| `OperationsMap.jsx` | The signature honeycomb node graph |
| `AgentList.jsx` | Live agent activity list with status dots |
| `RunsTable.jsx` | Dense run history table |
| `WorkflowCanvas.jsx` | Workflow builder — draggable hex nodes on graphite paper |
| `NewAutomationModal.jsx` | Create-automation modal flow |
| `Badge.jsx`, `Button.jsx`, `Input.jsx` | Primitives |

## Screens

`index.html` runs an interactive prototype with three reachable screens:

1. **Overview** — dashboard with KPIs, operations map, agent activity, runs table, suggestions
2. **Workflow builder** — empty canvas → drag hex nodes → connect them
3. **New automation modal** — opens from the Overview "New automation" button

Click the sidebar items to switch views; the prototype is hash-routed.
