import { describe, expect, it } from "vitest";
import { settingsToSetupRedirects } from "../../src/navigation/setup-redirects";

describe("settings to setup redirects", () => {
  it("maps representative legacy settings setup paths to canonical setup paths", () => {
    expect(settingsToSetupRedirects).toEqual(
      expect.arrayContaining([
        { source: "/settings", destination: "/setup", permanent: true },
        { source: "/settings/connectors", destination: "/setup/connectors", permanent: true },
        { source: "/settings/setup-health", destination: "/setup/health", permanent: true },
        { source: "/settings/health", destination: "/setup/health", permanent: true },
        { source: "/settings/adapters", destination: "/setup/adapters", permanent: true },
        { source: "/settings/embeddings", destination: "/setup/embeddings", permanent: true },
        { source: "/settings/work-intake", destination: "/setup/work-intake", permanent: true },
        { source: "/settings/workflow-capture", destination: "/setup/workflow-capture", permanent: true },
        { source: "/settings/workflow-capture/:path*", destination: "/setup/workflow-capture/:path*", permanent: true },
        { source: "/settings/sop-importer", destination: "/setup/sop-importer", permanent: true },
      ]),
    );
  });
});
