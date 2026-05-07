import type { Provisioner, ProvisionProgress, ProvisionStatus, ProvisionerInput } from "./types";
import { getOpenAIImagesApiAuthStatus } from "../adapters/openai-auth";

export class OpenAIImageProvisioner implements Provisioner {
  async check(input: ProvisionerInput): Promise<ProvisionStatus> {
    if (input.recommendedModel !== "gpt-image-2" && input.recommendedModel !== "gpt-image-2-2026-04-21") {
      return {
        satisfied: false,
        fixable: false,
        reason: "openai-image roles must use gpt-image-2 or snapshot gpt-image-2-2026-04-21.",
      };
    }

    const auth = getOpenAIImagesApiAuthStatus();
    if (!auth.available) {
      return {
        satisfied: false,
        fixable: false,
        reason: `OpenAI Images API auth is unavailable. ${auth.reason ?? ""}`.trim(),
      };
    }

    return { satisfied: true, fixable: false, reason: `OpenAI Images API auth available via ${auth.label}.` };
  }

  async *provision(input: ProvisionerInput): AsyncGenerator<ProvisionProgress> {
    yield { phase: "done", status: await this.check(input) };
  }
}
