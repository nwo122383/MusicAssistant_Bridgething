import { beforeEach, describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";
import { BridgethingClient } from "@bridgething/client";

const bridge = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn() }));
vi.mock("@bridgething/client", () => ({ BridgethingClient: class {
  net = { fetch: bridge.fetch };
  close = bridge.close;
} }));

function setup() {
  const client = new MassClient();
  const internals = client as unknown as {
    haBaseUrl: string; haIngress: unknown;
    haRequest: ReturnType<typeof vi.fn>;
    haMassCommand: (name: string) => Promise<unknown>;
    ensureHaIngress: () => Promise<unknown>;
  };
  internals.haBaseUrl = "https://ha.example.invalid";
  internals.haRequest = vi.fn(async (type: string, args?: Record<string, string>) => {
    if (type === "get_panels") return { ma: { title: "Music Assistant", config: { addon: "test-addon" } } };
    if (args?.endpoint.endsWith("/info")) return { ingress_url: "/api/hassio_ingress/test-addon" };
    return { session: "test-session" };
  });
  return { client, internals, command: internals.haMassCommand.bind(client) };
}
beforeEach(async () => {
  await import("@bridgething/client");
  expect(new BridgethingClient().net.fetch).toBe(bridge.fetch);
  vi.clearAllMocks();
  bridge.fetch.mockResolvedValue({ ok: true, response: { response: { status: 200, body: new TextEncoder().encode("{}") } } });
});

describe("HA ingress connection lifecycle", () => {
  it("shares session renewal between concurrent MA requests", async () => {
    const { internals, command } = setup();
    const [first, second] = await Promise.all([internals.ensureHaIngress(), internals.ensureHaIngress()]);
    expect(first).toBe(second);
    expect(internals.haRequest).toHaveBeenCalledTimes(3);
    await command("players/all");
    await command("player_queues/all");
    expect(bridge.fetch).toHaveBeenCalledTimes(2);
    await command("info");
    expect(internals.haRequest).toHaveBeenCalledTimes(3);
  });

  it("retries discovery after a failed session renewal", async () => {
    const { internals, command } = setup();
    internals.haRequest.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(command("info")).rejects.toThrow("temporary failure");
    await expect(command("info")).resolves.toEqual({});
    expect(bridge.fetch).toHaveBeenCalledOnce();
  });

  it("does not continue session discovery on a replacement socket", async () => {
    const { client, internals, command } = setup();
    internals.haRequest.mockImplementationOnce(async () => {
      client.disconnect();
      return { ma: { title: "Music Assistant", config: { addon: "test-addon" } } };
    });
    await expect(command("info")).rejects.toThrow("connection changed");
    expect(internals.haRequest).toHaveBeenCalledOnce();
    expect(internals.haIngress).toBeUndefined();
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("does not restore a session after disconnect during renewal", async () => {
    const { client, internals, command } = setup();
    const request = internals.haRequest.getMockImplementation() as (type: string, args?: Record<string, string>) => Promise<unknown>;
    internals.haRequest.mockImplementation(async (type: string, args?: Record<string, string>) => {
      if (args?.endpoint === "/ingress/session") client.disconnect();
      return request(type, args);
    });
    await expect(command("info")).rejects.toThrow("connection changed");
    expect(internals.haIngress).toBeUndefined();
    expect(bridge.fetch).not.toHaveBeenCalled();
  });

  it("discards an old HTTP result without clearing the replacement session", async () => {
    const { client, internals, command } = setup();
    const replacement = { url: "new", session: "new", expires: Date.now() + 60_000 };
    bridge.fetch.mockImplementationOnce(async () => {
      client.disconnect();
      internals.haIngress = replacement;
      return { ok: true, response: { response: { status: 401, body: new Uint8Array() } } };
    });
    await expect(command("info")).rejects.toThrow("connection changed");
    expect(internals.haIngress).toBe(replacement);
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it("renews an invalid ingress session on the next request, without replaying commands", async () => {
    const { internals, command } = setup();
    bridge.fetch.mockResolvedValueOnce({ ok: true, response: { response: { status: 401, body: new Uint8Array() } } });
    await expect(command("players/cmd/play")).rejects.toThrow("401");
    expect(bridge.fetch).toHaveBeenCalledOnce();
    expect(internals.haIngress).toBeUndefined();
    await command("info");
    expect(internals.haRequest).toHaveBeenCalledTimes(6);
    expect(bridge.fetch).toHaveBeenCalledTimes(2);
  });
});
