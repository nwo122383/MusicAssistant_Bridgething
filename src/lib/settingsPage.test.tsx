import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsApp } from "../../settings/main";
import { decodeHaSession } from "./homeAssistantAuth";

const host = vi.hoisted(() => ({
  list: vi.fn(), docs: vi.fn(), set: vi.fn(), docSet: vi.fn(),
  refresh: () => {}, context: () => {},
}));
const auth = vi.hoisted(() => ({ connect: vi.fn(), login: vi.fn(), disconnect: vi.fn() }));
const haAuth = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("./homeAssistantAuth", async original => ({ ...await original<typeof import("./homeAssistantAuth")>(), signInToHomeAssistant: haAuth.signIn }));
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
  haAuth.signIn.mockResolvedValue({ origin: "https://ha.example.com", accessToken: "test-ha-access", refreshToken: "test-ha-refresh", expiresAt: Date.now() + 1800_000 });
});
afterEach(cleanup);

describe("phone settings page", () => {
  it("signs in to HA without manual token creation or storing a password", async () => {
    render(<SettingsApp />);
    await screen.findByDisplayValue("https://ha.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Home Assistant" }));
    await screen.findByText("Saved");
    const credential = host.set.mock.calls.find(([key]) => key === "token")?.[1];
    expect(decodeHaSession(credential, "https://ha.example.com")).toMatchObject({ accessToken: "test-ha-access", refreshToken: "test-ha-refresh" });
    expect(host.set).toHaveBeenCalledWith("transport", "homeassistant");
    expect(screen.queryByLabelText("Home Assistant long-lived access token")).toBeNull();
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("does not save an HA login that finishes after a device switch", async () => {
    let finish!: (session: unknown) => void;
    haAuth.signIn.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<SettingsApp />);
    await screen.findByDisplayValue("https://ha.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Home Assistant" }));
    await waitFor(() => expect(haAuth.signIn).toHaveBeenCalled());
    await act(async () => { host.context(); finish({ origin: "https://ha.example.com", accessToken: "old", refreshToken: "old", expiresAt: Date.now() + 1800_000 }); });
    expect(host.set).not.toHaveBeenCalled();
  });

  it("keeps an HA browser login alive when the host refreshes on browser return", async () => {
    let finish!: (session: unknown) => void;
    haAuth.signIn.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<SettingsApp />);
    await screen.findByDisplayValue("https://ha.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Home Assistant" }));
    await waitFor(() => expect(haAuth.signIn).toHaveBeenCalled());
    await act(async () => { host.refresh(); finish({ origin: "https://ha.example.com", accessToken: "new", refreshToken: "new", expiresAt: Date.now() + 1800_000 }); });
    await screen.findByText("Saved");
    expect(host.set).toHaveBeenCalledWith("transport", "homeassistant");
  });

  it("leaves existing credentials unchanged if HA sign-in is cancelled", async () => {
    haAuth.signIn.mockRejectedValueOnce(new Error("Sign-in cancelled"));
    render(<SettingsApp />);
    await screen.findByDisplayValue("https://ha.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Home Assistant" }));
    await screen.findByText("Sign-in cancelled");
    expect(screen.getByRole("status").textContent).toBe("Sign-in cancelled");
    expect(screen.getByRole("button", { name: "Sign in to Home Assistant" }).parentElement).toBe(screen.getByRole("status").parentElement);
    expect(host.set).not.toHaveBeenCalled();
  });

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
