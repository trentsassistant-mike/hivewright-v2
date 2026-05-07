import { spawn } from "child_process";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../../_lib/auth";

function runRestart(): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const bin = process.env.SYSTEMCTL_BIN ?? "systemctl";
    const service = process.env.HIVEWRIGHT_DISPATCHER_SERVICE ?? "hivewright-dispatcher";
    const proc = spawn(bin, ["--user", "restart", service], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? 1, stderr }));
    proc.on("error", (err) => resolve({ code: 1, stderr: err.message }));
  });
}

// Per-handler authorization (audit d20f7b46): restarting the dispatcher unit
// is an operationally destructive action. Session presence via
// requireApiAuth() is defense-in-depth on top of src/proxy.ts; the added
// requireSystemOwner() gate narrows execution to privileged (system-owner)
// callers so any authenticated non-owner session cannot trigger a restart.
export async function POST(request: Request) {
  void request;
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  const { code, stderr } = await runRestart();
  if (code !== 0) return jsonError(`systemctl exited ${code}: ${stderr.trim()}`, 500);
  return jsonOk({ restarted: true });
}
