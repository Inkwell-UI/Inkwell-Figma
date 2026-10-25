import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, SPEC_VERSION } from "@inkwell-ui/spec";
import { statusText, SyncClient, type Socket } from "../src/sync/client.js";
import { selectNode } from "../src/sync/select.js";
import { isSecret, newSecret } from "../src/sync/secret.js";

const SECRET = "ab".repeat(32);

class FakeSocket implements Socket {
  sent: any[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {}
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  recv(m: unknown) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
}
function setup() {
  vi.useFakeTimers();
  const socks: FakeSocket[] = [];
  const log = { hashReq: 0, resend: [] as string[][], states: [] as any[], need: [] as string[][], sel: [] as [string, boolean][] };
  const client = new SyncClient({
    ports: [8787, 8788], pluginSecret: SECRET, fileName: "My HUD", pluginVersion: "0.1.0", fileKey: "FK",
    open: (url) => { const s = new FakeSocket(url); socks.push(s); return s; },
    timers: { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as any) },
    requestHashTree: () => log.hashReq++,
    onResend: (swfId, ids) => log.resend.push([swfId, ...ids]),
    onNeedAssets: (h) => log.need.push(h),
    onSelectNode: (id, focus) => log.sel.push([id, focus]),
    onChange: (s) => log.states.push(s),
  });
  return { client, socks, log };
}
const ack = { type: "helloAck", ok: true, editorVersion: "1", protocolVersion: PROTOCOL_VERSION };

describe("SyncClient", () => {
  it("sends hello with versions, secret and file name (no token in the URL), becomes ready on ack, asks for the hash tree", () => {
    const { client, socks, log } = setup();
    client.start();
    expect(socks[0].url).toBe("ws://localhost:8787/");
    socks[0].onopen!();
    expect(socks[0].sent[0]).toEqual({ type: "hello", pluginVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION, specVersion: SPEC_VERSION, pluginSecret: SECRET, fileName: "My HUD", fileKey: "FK" });
    client.send({ type: "selection", ids: ["a"] }); // not ready yet: dropped
    expect(socks[0].sent).toHaveLength(1);
    socks[0].recv(ack);
    expect(client.state).toBe("ready");
    expect(log.hashReq).toBe(1);
    client.send({ type: "hashTree", swfId: "f", nodeHashes: { a: "1" } });
    expect(socks[0].sent[1]).toEqual({ type: "hashTree", swfId: "f", nodeHashes: { a: "1" } });
  });

  it("explains a failed sweep (editor not running) instead of flickering silently", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onclose!(); // port 8787 refused
    socks[1].onclose!(); // port 8788 refused: the sweep is over
    const last = log.states[log.states.length - 1];
    expect(last.state).toBe("disconnected");
    expect(last.error).toMatch(/Cannot reach the editor/);
  });

  it("shows the editor's mismatch error and does not reconnect", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onopen!();
    socks[0].recv({ ...ack, ok: false, error: "Protocol mismatch: update the plugin" });
    expect(client.state).toBe("refused");
    expect(log.states.at(-1)).toMatchObject({ state: "refused", error: "Protocol mismatch: update the plugin" });
    socks[0].onclose!();
    vi.advanceTimersByTime(60000);
    expect(socks).toHaveLength(1);
  });

  it("tries the next port, then backs off, and recovers", () => {
    const { client, socks } = setup();
    client.start();
    socks[0].onclose!(); // 8787 refused
    expect(socks[1].url).toContain(":8788/");
    socks[1].onclose!(); // all ports failed
    expect(socks).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(socks[2].url).toContain(":8787/");
    socks[2].onclose!(); socks[3].onclose!(); // second sweep fails: delay doubles
    vi.advanceTimersByTime(999);
    expect(socks).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(socks).toHaveLength(5);
  });

  it("reconnects after a drop and sends the hash tree again; handles status, resend, error", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onopen!(); socks[0].recv(ack);
    socks[0].recv({ type: "status", state: "synced" });
    expect(log.states.at(-1)).toMatchObject({ state: "ready", badge: "synced" });
    socks[0].recv({ type: "resend", swfId: "f", ids: ["x", "y"] });
    expect(log.resend).toEqual([["f", "x", "y"]]);
    // per-swf status rolls up: one swf in error keeps the badge on error
    socks[0].recv({ type: "status", swfId: "a", state: "error" });
    socks[0].recv({ type: "status", swfId: "b", state: "synced" });
    expect(log.states.at(-1)).toMatchObject({ badge: "error" });
    socks[0].recv({ type: "error", code: "c", message: "boom" });
    expect(log.states.at(-1)).toMatchObject({ badge: "error", error: "boom" });
    socks[0].recv("garbage"); // ignored

    socks[0].onclose!();
    vi.advanceTimersByTime(500);
    const s = socks.at(-1)!;
    expect(s.url).toContain(":8787/");
    s.onopen!(); s.recv(ack);
    expect(log.hashReq).toBe(2);
  });
});

describe("SyncClient approval (protocol 4)", () => {
  it("pending shows 'Waiting for approval', sends nothing more, and helloAck makes it ready", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onopen!();
    socks[0].recv({ type: "pending" });
    expect(client.state).toBe("pending");
    expect(statusText(log.states.at(-1))).toBe("Waiting for approval in the editor");
    client.send({ type: "selection", ids: ["a"] }); // not approved yet: dropped
    expect(socks[0].sent).toHaveLength(1);
    socks[0].recv(ack);
    expect(client.state).toBe("ready");
    expect(log.hashReq).toBe(1);
  });
  it("denied by the user: shows the reason and does not ask again", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onopen!();
    socks[0].recv({ type: "pending" });
    socks[0].recv({ type: "denied", reason: "denied" });
    expect(socks[0].closed).toBe(true);
    expect(log.states.at(-1)).toMatchObject({ state: "denied" });
    expect(statusText(log.states.at(-1))).toMatch(/^Denied: you denied/);
    socks[0].onclose!();
    vi.advanceTimersByTime(120000);
    expect(socks).toHaveLength(1);
  });
  it("busy and timeout: shows Denied with the reason and asks again later on the same port", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onopen!();
    socks[0].recv({ type: "denied", reason: "busy" });
    expect(statusText(log.states.at(-1))).toMatch(/^Denied: The editor is busy/);
    socks[0].onclose!();
    vi.advanceTimersByTime(4999);
    expect(socks).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socks).toHaveLength(2);
    expect(socks[1].url).toContain(":8787/");
    socks[1].onopen!();
    socks[1].recv({ type: "denied", reason: "timeout" });
    socks[1].onclose!();
    vi.advanceTimersByTime(59999);
    expect(socks).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(socks).toHaveLength(3);
  });
  it("a mismatch is still refused for good; connected shows the badge", () => {
    expect(statusText({ state: "ready", badge: "synced" })).toBe("synced");
    expect(statusText({ state: "ready" })).toBe("Connected");
    expect(statusText({ state: "connecting" })).toBe("Connecting...");
  });
  it("makes a 64-hex secret from 32 random bytes", () => {
    const s = newSecret((a) => a.map((_, i) => i * 8));
    expect(s).toBe(Array.from({ length: 32 }, (_, i) => (i * 8).toString(16).padStart(2, "0")).join(""));
    expect(isSecret(s)).toBe(true);
    expect(isSecret(s.toUpperCase())).toBe(false);
    expect(isSecret(s.slice(1))).toBe(false);
  });
});

describe("SyncClient assets (protocol 3)", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  it("asks the main thread once per hash per connection, and again after a reconnect", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onopen!(); socks[0].recv(ack);
    socks[0].recv({ type: "needAssets", hashes: [A, A] });
    socks[0].recv({ type: "needAssets", hashes: [A, B] });
    socks[0].recv({ type: "needAssets", hashes: [B] });
    expect(log.need).toEqual([[A], [B]]);
    client.send({ type: "asset", hash: A, data: "AAAA" });
    expect(socks[0].sent.at(-1)).toEqual({ type: "asset", hash: A, data: "AAAA" });
    socks[0].onclose!();
    vi.runOnlyPendingTimers();
    const s = socks.at(-1)!;
    s.onopen!(); s.recv(ack);
    s.recv({ type: "needAssets", hashes: [A] });
    expect(log.need).toEqual([[A], [B], [A]]);
  });
  it("ignores a needAssets with a malformed hash (never reaches the main thread)", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onopen!(); socks[0].recv(ack);
    socks[0].recv({ type: "needAssets", hashes: ["../x"] });
    expect(log.need).toEqual([]);
  });
});

describe("selectNode (protocol 5)", () => {
  it("client forwards it only when ready, with focus defaulting to false", () => {
    const { client, socks, log } = setup();
    client.start();
    socks[0].onopen!();
    socks[0].recv({ type: "selectNode", nodeId: "1:2" });
    expect(log.sel).toEqual([]);
    socks[0].recv(ack);
    socks[0].recv({ type: "selectNode", nodeId: "1:2" });
    socks[0].recv({ type: "selectNode", nodeId: "1:3", focus: true });
    socks[0].recv({ type: "selectNode" });
    expect(log.sel).toEqual([["1:2", false], ["1:3", true]]);
  });
  it("a protocol 4 editor ack is refused by nothing here, but our hello says protocol 5", () => {
    const { client, socks } = setup();
    client.start();
    socks[0].onopen!();
    expect(PROTOCOL_VERSION).toBe(5);
    expect(socks[0].sent[0].protocolVersion).toBe(5);
  });
  const mk = (nodes: Record<string, any>) => {
    const page: any = { selection: [] };
    const zoomed: unknown[][] = [];
    return { page, zoomed, api: { currentPage: page, getNodeByIdAsync: async (id: string) => nodes[id] ?? null, viewport: { scrollAndZoomIntoView: (n: unknown[]) => zoomed.push(n) } } };
  };
  it("selects a node on the page; focus also zooms", async () => {
    const t = mk({});
    const n: any = { id: "1:2", type: "FRAME", parent: t.page };
    const child: any = { id: "1:3", type: "TEXT", parent: n };
    const api = { ...t.api, getNodeByIdAsync: async (id: string) => (id === "1:2" ? n : id === "1:3" ? child : null) };
    expect(await selectNode(api as any, "1:3", false)).toBe(true);
    expect(t.page.selection).toEqual([child]);
    expect(t.zoomed).toEqual([]);
    await selectNode(api as any, "1:2", true);
    expect(t.page.selection).toEqual([n]);
    expect(t.zoomed).toEqual([[n]]);
  });
  it("unknown, removed, other-page and page nodes change nothing", async () => {
    const { api, page, zoomed } = mk({ r: { id: "r", type: "FRAME", removed: true, parent: null }, o: { id: "o", type: "FRAME", parent: { parent: null } }, p: { id: "p", type: "PAGE", parent: null } });
    for (const id of ["nope", "r", "o", "p"]) expect(await selectNode(api as any, id, true)).toBe(false);
    expect(page.selection).toEqual([]);
    expect(zoomed).toEqual([]);
  });
});
