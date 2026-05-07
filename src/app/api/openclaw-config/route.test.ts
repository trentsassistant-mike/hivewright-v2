import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireSystemOwner: vi.fn(),
  spawn: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("fs", () => ({
  default: {
    readFileSync: mocks.readFileSync,
  },
}));

import { GET, POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/openclaw-config", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function getRequest() {
  return new Request("http://localhost/api/openclaw-config");
}

function mockOpenClawExit(code: number, stderr = "") {
  mocks.spawn.mockImplementationOnce(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => {
      if (stderr) proc.stderr.emit("data", stderr);
      proc.emit("close", code);
    });
    return proc;
  });
}

describe("GET /api/openclaw-config owner gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      agents: {
        defaults: {
          model: { primary: "gpt-5.4", fallbacks: ["gpt-5.4-mini"] },
          models: {
            "gpt-5.4": { alias: "frontier" },
          },
        },
        list: [
          {
            id: "dev-agent",
            name: "Developer",
            model: { primary: "gpt-5.4", fallbacks: ["gpt-5.4-mini"] },
          },
        ],
      },
    }));
  });

  it("returns 401 for signed-out callers before the owner gate", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(mocks.requireSystemOwner).not.toHaveBeenCalled();
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });

  it("returns 403 for signed-in callers without system-owner privilege", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await GET(getRequest());

    expect(res.status).toBe(403);
    expect(mocks.requireApiAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireSystemOwner).toHaveBeenCalledTimes(1);
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });

  it("returns 200 for system owners and reads the OpenClaw config", async () => {
    const res = await GET(getRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      defaultModel: "gpt-5.4",
      fallbacks: ["gpt-5.4-mini"],
      availableModels: [{ id: "gpt-5.4", alias: "frontier" }],
      agents: [
        {
          id: "dev-agent",
          model: "gpt-5.4",
          fallbacks: ["gpt-5.4-mini"],
          name: "Developer",
        },
      ],
    });
    expect(mocks.readFileSync).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/openclaw-config owner gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("preserves unauthenticated denial before the owner gate", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(request({ action: "set-default-model", model: "gpt-5.4" }));

    expect(res.status).toBe(401);
    expect(mocks.requireSystemOwner).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-owner callers before invoking OpenClaw", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await POST(request({ action: "set-default-model", model: "gpt-5.4" }));

    expect(res.status).toBe(403);
    expect(mocks.requireApiAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireSystemOwner).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("allows system owners to reach the existing OpenClaw mutation path", async () => {
    mockOpenClawExit(0);

    const res = await POST(request({ action: "set-default-model", model: "gpt-5.4" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ updated: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "openclaw",
      ["config", "set", "agents.defaults.model.primary", "gpt-5.4"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 },
    );
  });
});
