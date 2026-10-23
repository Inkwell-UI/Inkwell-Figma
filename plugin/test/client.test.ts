import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, SPEC_VERSION } from "@inkwell-ui/spec";
import { SyncClient, type Socket } from "../src/sync/client.js";

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
  const log = { hashReq: 0, resend: [] as string[][], states: [] as any[] };
  const client = new SyncClient({
    ports: [8787, 8788], token: "t k", pluginVersion: "0.1.0", fileKey: "FK",
    open: (url) => { const s = new FakeSocket(url); socks.push(s); return s; },
    timers: { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as any) },
    requestHashTree: () => log.hashReq++,
    onResend: (swfId, ids) => log.resend.push([swfId, ...ids]),
    onChange: (s) => log.states.push(s),
  });
  return { client, socks, log };
}
const ack = { type: "helloAck", ok: true, editorVersion: "1", protocolVersion: PROTOCOL_VERSION };

describe("SyncClient", () => {
  it("sends hello with versions and the encoded token, becomes ready on ack, asks for the hash tree", () => {
    const { client, socks, log } = setup();
    client.start();
    expect(socks[0].url).toBe("ws://localhost:8787/?token=t%20k");
    socks[0].onopen!();
    expect(socks[0].sent[0]).toEqual({ type: "hello", pluginVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION, specVersion: SPEC_VERSION, fileKey: "FK" });
    client.send({ type: "selection", ids: ["a"] }); // not ready yet: dropped
    expect(socks[0].sent).toHaveLength(1);
    socks[0].recv(ack);
    expect(client.state).toBe("ready");
    expect(log.hashReq).toBe(1);
    client.send({ type: "hashTree", swfId: "f", nodeHashes: { a: "1" } });
    expect(socks[0].sent[1]).toEqual({ type: "hashTree", swfId: "f", nodeHashes: { a: "1" } });
  });

  it("explains a failed sweep (wrong token or editor not running) instead of flickering silently", () => {
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
