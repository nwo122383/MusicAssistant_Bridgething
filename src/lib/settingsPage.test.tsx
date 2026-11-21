import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsApp } from "../../settings/main";

const host = vi.hoisted(() => ({
  list: vi.fn(), docs: vi.fn(), set: vi.fn(), docSet: vi.fn(),
  refresh: () => {}, context: () => {},
}));
const auth = vi.hoisted(() => ({ connect: vi.fn(), login: vi.fn(), disconnect: vi.fn() }));
vi.mock("./MassClient", () => ({ MassClient: class {
  connect = auth.connect;
  login = auth.login;
  disconnect = auth.disconnect;
  onClose() { return () => {}; }
} }));
vi.mock("@bridgething/settings-client/settings", () => ({ settings: {
  config: { list: host.list, set: host.set }, doc: { list: host.docs, set: host.docSet }, done: vi.fn(),
  onRefresh: (fn: () => void) => { host.refresh = fn; return () => {}; },
  onContextChanged: (fn: () => void) => { host.context = fn; return () => {}; },
} }));

beforeEach(() => {
  vi.clearAllMocks();
  host.list.mockResolvedValue([{ key: "serverUrl", value: "https://ha.example.com" }, { key: "transport", value: "homeassistant" }]);
  host.docs.mockResolvedValue([{ key: "displaySize", value: "xlarge" }]);
  host.set.mockResolvedValue(undefined);
  host.docSet.mockResolvedValue(undefined);
  auth.connect.mockResolvedValue(undefined);
  auth.login.mockResolvedValue("returned-device-token");
});
afterEach(cleanup);

describe("phone settings page", () => {
  it("connects using only a Remote ID, then signs in and saves the returned token, never the password", async () => {
    const id = "CEIRCEIRCEIRCEIRCEIRCEIRCE";
    host.list.mockResolvedValue([{ key: "remoteId", value: id }, { key: "transport", value: "webrtc" }]);
    render(<SettingsApp />);
    await screen.findByDisplayValue(id);
    fireEvent.click(screen.getByRole("button", { name: "Connect WebRTC" }));
    await screen.findByLabelText("Music Assistant username");
    expect(auth.connect).toHaveBeenCalledWith(id, undefined, "webrtc", { tcpRelayOnly: false });
    fireEvent.change(screen.getByLabelText("Music Assistant username"), { target: { value: "test-user" } });
    fireEvent.change(screen.getByLabelText("Music Assistant password"), { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in and save" }));
    await screen.findByText("Saved");
    expect(auth.login).toHaveBeenCalledWith("test-user", "test-password");
    expect(host.set).toHaveBeenCalledWith("token", "returned-device-token");
    expect(host.set.mock.calls.flat()).not.toContain("test-password");
    expect(host.set.mock.calls.flat()).not.toContain("test-user");
    expect(auth.disconnect).toHaveBeenCalled();
    expect(screen.queryByLabelText("Music Assistant password")).toBeNull();
  });

  it("does not save credentials when sign-in fails", async () => {
    host.list.mockResolvedValue([{ key: "remoteId", value: "CEIRCEIRCEIRCEIRCEIRCEIRCE" }, { key: "transport", value: "webrtc" }]);
    auth.login.mockRejectedValue(new Error("Invalid credentials"));
    render(<SettingsApp />);
    await screen.findByDisplayValue("CEIRCEIRCEIRCEIRCEIRCEIRCE");
    fireEvent.click(screen.getByRole("button", { name: "Connect WebRTC" }));
    await screen.findByLabelText("Music Assistant username");
    fireEvent.change(screen.getByLabelText("Music Assistant username"), { target: { value: "test-user" } });
    fireEvent.change(screen.getByLabelText("Music Assistant password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in and save" }));
    await screen.findByText("Invalid credentials");
    expect(host.set).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Music Assistant password") as HTMLInputElement).value).toBe("");
  });

  it("cancels an unfinished phone connection if the selected device changes", async () => {
    host.list.mockResolvedValue([{ key: "remoteId", value: "CEIRCEIRCEIRCEIRCEIRCEIRCE" }, { key: "transport", value: "webrtc" }]);
    let finish!: () => void;
    auth.connect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<SettingsApp />);
    await screen.findByDisplayValue("CEIRCEIRCEIRCEIRCEIRCEIRCE");
    fireEvent.click(screen.getByRole("button", { name: "Connect WebRTC" }));
    await waitFor(() => expect(auth.connect).toHaveBeenCalled());
    host.list.mockResolvedValue([{ key: "serverUrl", value: "https://other.example.com" }, { key: "transport", value: "homeassistant" }]);
    await act(async () => { host.context(); finish(); });
    await screen.findByDisplayValue("https://other.example.com");
    expect(auth.disconnect).toHaveBeenCalled();
    expect(screen.queryByLabelText("Music Assistant username")).toBeNull();
    expect(host.set).not.toHaveBeenCalled();
  });
  it("saves WebRTC settings without a server URL and reloads the selected path", async () => {
    const id = "CEIRCEIRCEIRCEIRCEIRCEIRCE";
    host.list.mockResolvedValue([{ key: "remoteId", value: id }, { key: "transport", value: "webrtc" }]);
    render(<SettingsApp />);
    await screen.findByDisplayValue(id);
    expect(screen.queryByLabelText("Music Assistant HTTPS URL")).toBeNull();
    fireEvent.change(screen.getByLabelText("Music Assistant access token"), { target: { value: "test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    expect(host.set).toHaveBeenCalledWith("remoteId", id);
    expect(host.set).toHaveBeenCalledWith("transport", "webrtc");
    expect(host.set).toHaveBeenCalledWith("token", "test-token");
    expect(host.set).not.toHaveBeenCalledWith("serverUrl", "");
  });
  it("renders saved device settings", async () => {
    render(<SettingsApp />);
    await screen.findByDisplayValue("https://ha.example.com");
    expect((screen.getByLabelText("Display size") as HTMLSelectElement).value).toBe("xlarge");
  });

  it("reloads values when the host switches devices", async () => {
    render(<SettingsApp />);
    await screen.findByDisplayValue("https://ha.example.com");
    host.list.mockResolvedValue([{ key: "serverUrl", value: "https://other.example.com" }]);
    await act(async () => host.context());
    await screen.findByDisplayValue("https://other.example.com");
  });

  it("stops an in-flight save from writing more fields after a device switch", async () => {
    render(<SettingsApp />);
    await screen.findByDisplayValue("https://ha.example.com");
    let finish!: () => void;
    host.set.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(host.set).toHaveBeenCalledTimes(1));
    await act(async () => { host.context(); finish(); });
    await screen.findByText(/selected device changed/);
    expect(host.set).toHaveBeenCalledTimes(1);
    expect(host.docSet).not.toHaveBeenCalled();
  });
});
