import fs from "fs";
import path from "path";
import os from "os";

export interface OpenClawLocalConfig {
  endpoint: string;
  authToken: string;
  installed: boolean;
}

export function detectOpenClawConfig(): OpenClawLocalConfig {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");

  if (!fs.existsSync(configPath)) {
    return { endpoint: "", authToken: "", installed: false };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const port = config.gateway?.port || 18789;
    const token = config.gateway?.auth?.token || "";

    return {
      endpoint: `http://localhost:${port}`,
      authToken: token,
      installed: true,
    };
  } catch {
    return { endpoint: "", authToken: "", installed: false };
  }
}
