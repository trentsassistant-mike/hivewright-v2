import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONNECTOR_REGISTRY } from "@/connectors/registry";
import { buildConnectorGapMap, renderConnectorGapMapMarkdown, type ControlledAutonomyToolRequirement } from "@/readiness/connectors/connector-gap-map";

const defaultRequirements: ControlledAutonomyToolRequirement[] = [
  { toolName: "Gmail", neededCapability: "read" },
  { toolName: "Calendar", neededCapability: "read" },
  { toolName: "Drive Docs", neededCapability: "read" },
  { toolName: "Xero", neededCapability: "read" },
  { toolName: "Stripe", neededCapability: "read" },
  { toolName: "CRM", neededCapability: "read" },
  { toolName: "Discord", neededCapability: "notify" },
];

const rows = buildConnectorGapMap({ requirements: defaultRequirements, connectors: CONNECTOR_REGISTRY });
const outputDir = path.join(process.cwd(), "tmp", "readiness");
mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "connector-gap-map.md");
writeFileSync(outputPath, `${renderConnectorGapMapMarkdown(rows)}\n`);
console.log(outputPath);
