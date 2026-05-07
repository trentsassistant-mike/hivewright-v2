import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { POST } from "../../src/app/api/dispatcher/restart/route";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "systemctl-stub-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYSTEMCTL_BIN;
});

describe("POST /api/dispatcher/restart", () => {
  it("returns 200 when systemctl exits 0", async () => {
    const stub = path.join(tmp, "systemctl");
    fs.writeFileSync(stub, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(stub, 0o755);
    process.env.SYSTEMCTL_BIN = stub;

    const res = await POST(new Request("http://x", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { restarted: boolean } };
    expect(body.data.restarted).toBe(true);
  });

  it("returns 500 when systemctl exits nonzero", async () => {
    const stub = path.join(tmp, "systemctl");
    fs.writeFileSync(stub, "#!/usr/bin/env bash\necho boom >&2\nexit 3\n");
    fs.chmodSync(stub, 0o755);
    process.env.SYSTEMCTL_BIN = stub;

    const res = await POST(new Request("http://x", { method: "POST" }));
    expect(res.status).toBe(500);
  });
});
