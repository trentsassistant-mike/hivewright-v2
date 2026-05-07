export interface DiscoveredModel {
  provider: string;
  adapterType: string;
  modelId: string;
  displayName: string;
  family: string | null;
  capabilities: string[];
  local: boolean;
  costPerInputToken?: string | null;
  costPerOutputToken?: string | null;
  benchmarkQualityScore?: number | null;
  routingCostScore?: number | null;
  metadataSourceName?: string | null;
  metadataSourceUrl?: string | null;
}

export interface ModelDiscoveryImportInput {
  hiveId: string;
  adapterType: string;
  provider: string;
  credentialId?: string | null;
  assignCredentialToHiveModels?: boolean;
  source: string;
  models: DiscoveredModel[];
}

export interface ModelDiscoveryImportResult {
  runId: string;
  catalogIds: string[];
  modelsSeen: number;
  modelsImported: number;
  modelsAutoEnabled: number;
  modelsMarkedStale: number;
}
