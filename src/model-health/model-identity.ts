export interface ConfiguredModelIdentityInput {
  provider: string;
  adapterType: string;
  modelId: string;
}

interface ModelAliasRow {
  provider: string;
  adapter_type: string;
  model_id: string;
  enabled: boolean;
  fallback_priority: number;
}

export function canonicalModelIdForAdapter(adapterType: string, modelId: string): string {
  const adapter = adapterType.trim().toLowerCase();
  const model = modelId.trim();
  const lowerModel = model.toLowerCase();
  if (!model || model.includes("/")) return model;

  if (adapter === "codex" && lowerModel.startsWith("gpt-")) return `openai-codex/${model}`;
  if (adapter === "claude-code" && lowerModel.startsWith("claude-")) return `anthropic/${model}`;
  if (adapter === "gemini" && lowerModel.startsWith("gemini-")) return `google/${model}`;
  if (adapter === "ollama") return `ollama/${model}`;

  return model;
}

export function configuredModelIdentityKey(input: ConfiguredModelIdentityInput): string {
  return [
    input.provider.trim().toLowerCase(),
    input.adapterType.trim().toLowerCase(),
    canonicalModelIdForAdapter(input.adapterType, input.modelId).toLowerCase(),
  ].join(":");
}

export function collapseConfiguredModelAliasRows<T extends ModelAliasRow>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = configuredModelIdentityKey({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: row.model_id,
    });
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()].map((group) => {
    const canonicalModelId = canonicalModelIdForAdapter(group[0].adapter_type, group[0].model_id);
    return [...group].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const aIsCanonical = a.model_id === canonicalModelId;
      const bIsCanonical = b.model_id === canonicalModelId;
      if (aIsCanonical !== bIsCanonical) return aIsCanonical ? -1 : 1;
      return a.fallback_priority - b.fallback_priority;
    })[0];
  });
}
