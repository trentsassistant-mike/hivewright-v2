import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../../_lib/auth";
import { getUpdatePlan, getUpdateStatus } from "@/system/update-runtime";

function updateLogPath() {
  const dir = path.join(process.cwd(), ".hivewright", "update-logs");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `update-${stamp}.log`);
}

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const status = await getUpdateStatus({ fetch: true });
  const plan = getUpdatePlan(status, true);
  return jsonOk({ status, plan });
}

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  const body = await request.json().catch(() => ({})) as { restart?: boolean };
  const restart = body.restart !== false;
  const status = await getUpdateStatus({ fetch: true });
  const plan = getUpdatePlan(status, restart);

  if (!plan.allowed) {
    return jsonError(plan.message, 409);
  }

  const logPath = updateLogPath();
  const out = fs.openSync(logPath, "a");
  const args = ["run", "hivewright:update", "--", "--apply", "--yes"];
  if (restart) args.push("--restart");

  const child = spawn("npm", args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });

  child.unref();
  fs.closeSync(out);

  return jsonOk({
    started: true,
    pid: child.pid,
    logPath,
    status,
    plan,
    warning: "HiveWright may restart while this update runs. Track progress from the log path or terminal.",
  }, 202);
}
