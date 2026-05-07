export interface AdapterCapabilities {
  persistentSessions: boolean;
  streaming: boolean;
  localRuntime: boolean;
  toolUse: boolean;
  worktreeContext: boolean;
  imageGeneration: boolean;
}

export type AdapterCapability = keyof AdapterCapabilities;

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  persistentSessions: false,
  streaming: false,
  localRuntime: false,
  toolUse: false,
  worktreeContext: false,
  imageGeneration: false,
};

const ADAPTER_CAPABILITIES: Record<string, AdapterCapabilities> = {
  codex: {
    persistentSessions: true,
    streaming: true,
    localRuntime: false,
    toolUse: true,
    worktreeContext: true,
    imageGeneration: false,
  },
  openclaw: {
    persistentSessions: true,
    streaming: true,
    localRuntime: false,
    toolUse: true,
    worktreeContext: true,
    imageGeneration: false,
  },
  "claude-code": {
    persistentSessions: false,
    streaming: true,
    localRuntime: false,
    toolUse: true,
    worktreeContext: true,
    imageGeneration: false,
  },
  gemini: {
    persistentSessions: false,
    streaming: true,
    localRuntime: false,
    toolUse: false,
    worktreeContext: false,
    imageGeneration: false,
  },
  ollama: {
    persistentSessions: false,
    streaming: false,
    localRuntime: true,
    toolUse: false,
    worktreeContext: false,
    imageGeneration: false,
  },
  "openai-image": {
    persistentSessions: false,
    streaming: false,
    localRuntime: false,
    toolUse: false,
    worktreeContext: false,
    imageGeneration: true,
  },
};

export function getAdapterCapabilities(adapterType: string): AdapterCapabilities {
  return ADAPTER_CAPABILITIES[adapterType] ?? DEFAULT_CAPABILITIES;
}

export function adapterSupports(adapterType: string, capability: AdapterCapability): boolean {
  return getAdapterCapabilities(adapterType)[capability];
}
