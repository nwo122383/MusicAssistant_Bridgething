import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MassClient } from "./MassClient";

const rtc = vi.hoisted(() => ({ sockets: [] as Array<{
  message: (data: string) => void; closed: () => void; error: (error: Error) => void;
  send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; isOpen: () => boolean;
  fetchImage: ReturnType<typeof vi.fn>;
}> }));
vi.mock("./WebRtcSocket", () => ({ createWebRtcSocket: (_id: string, message: (data: string) => void, closed: () => void, error: (error: Error) => void) => {
  const socket = { message, closed, error, send: vi.fn(), close: vi.fn(), isOpen: () => true, ready: Promise.resolve(), fetchImage: vi.fn() };
  rtc.sockets.push(socket);
  return socket;
} }));

let client: MassClient;
beforeEach(() => { rtc.sockets.length = 0; client = new MassClient(); });
afterEach(() => { client.disconnect(); vi.useRealTimers(); });
const greeting = JSON.stringify({ server_id: "test-server", server_version: "2.10.13" });

describe("Music Assistant over WebRTC", () => {
  it("allows slow remote responses but still rejects an unresponsive command", async () => {
    vi.useFakeTimers();
    const connecting = client.connect("remote-id", undefined, "webrtc");
    rtc.sockets[0].message(greeting);
    await connecting;
    const command = client.command("players/all");
    const request = JSON.parse(rtc.sockets[0].send.mock.calls[0][0]);
    await vi.advanceTimersByTimeAsync(20_000);
    rtc.sockets[0].message(JSON.stringify({ message_id: request.message_id, result: [] }));
    expect(await command).toEqual([]);
    const timedOut = expect(client.command("player_queues/all")).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await timedOut;
  });
  it("authenticates over the data channel before becoming ready", async () => {
    const connecting = client.connect("remote-id", "test-token", "webrtc");
    const socket = rtc.sockets[0];
    socket.message(greeting);
    const auth = JSON.parse(socket.send.mock.calls[0][0]);
    expect(auth.command).toBe("auth");
    expect(auth.args.token).toBe("test-token");
    socket.message(JSON.stringify({ message_id: auth.message_id, result: {} }));
    await connecting;
    const players = client.command("players/all");
    const request = JSON.parse(socket.send.mock.calls[1][0]);
    socket.message(JSON.stringify({ message_id: request.message_id, result: [{ player_id: "move" }] }));
    expect(await players).toEqual([{ player_id: "move" }]);
  });

  it("rejects a connection immediately when Bluetooth recovery replaces it", async () => {
    const connecting = client.connect("remote-id", undefined, "webrtc");
    const rejected = expect(connecting).rejects.toThrow(/replaced/);
    client.disconnect();
    await rejected;
    expect(rtc.sockets[0].close).toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it("ignores late callbacks from an old connection", async () => {
    const first = client.connect("remote-id", undefined, "webrtc");
    rtc.sockets[0].message(greeting);
    await first;
    const second = client.connect("remote-id", undefined, "webrtc");
    rtc.sockets[1].message(greeting);
    await second;
    rtc.sockets[0].closed();
    rtc.sockets[0].message(greeting);
    expect(client.isConnected()).toBe(true);
    expect(rtc.sockets[1].close).not.toHaveBeenCalled();
  });

  it("notifies the reconnect logic when an established data channel fails", async () => {
    const closed = vi.fn();
    client.onClose(closed);
    const connecting = client.connect("remote-id", undefined, "webrtc");
    rtc.sockets[0].message(greeting);
    await connecting;
    rtc.sockets[0].error(new Error("Data channel error"));
    expect(closed).toHaveBeenCalledOnce();
    expect(client.isConnected()).toBe(false);
  });
});
