import { EditorMessage, PROTOCOL_VERSION, SPEC_VERSION, type PluginMessage } from "@inkwell-ui/spec";
import type { Timers } from "./debounce.js";

export interface Socket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
}
export type State = "disconnected" | "connecting" | "handshaking" | "ready" | "refused";
export type Badge = "synced" | "compiling" | "error";

export interface ClientOpts {
  ports: readonly number[];
  token: string;
  pluginVersion: string;
  fileKey?: string;
  open(url: string): Socket;
  timers: Timers;
  /** Ask the main thread for its hash tree; it answers via client.hashTree(). */
  requestHashTree(): void;
  /** Editor asked for fresh subtrees; main thread answers via client.send(patch). */
  onResend(ids: string[]): void;
  onChange(s: { state: State; badge?: Badge; error?: string }): void;
}

/** Plugin-side protocol: port scan, hello/helloAck, backoff reconnect, hash tree on (re)connect. */
export class SyncClient {
  state: State = "disconnected";
  private sock: Socket | null = null;
  private port = 0; // index into ports
  private failures = 0;
  private timer: unknown;
  private stopped = true;
  constructor(private o: ClientOpts) {}

  start() { this.stopped = false; this.port = 0; this.connect(); }
  stop() { this.stopped = true; this.o.timers.clear(this.timer); this.sock?.close(); this.sock = null; this.set("disconnected"); }

  /** Send a plugin message (patch, selection, hashTree); dropped unless the handshake is done. */
  send(m: PluginMessage) {
    if (this.state === "ready") this.sock?.send(JSON.stringify(m));
  }

  private set(state: State, extra: { badge?: Badge; error?: string } = {}) {
    this.state = state;
    this.o.onChange({ state, ...extra });
  }

  private connect() {
    const url = `ws://localhost:${this.o.ports[this.port]}/?token=${encodeURIComponent(this.o.token)}`;
    const s = this.o.open(url);
    this.sock = s;
    this.set("connecting");
    s.onopen = () => {
      this.set("handshaking");
      s.send(JSON.stringify({
        type: "hello", pluginVersion: this.o.pluginVersion, protocolVersion: PROTOCOL_VERSION, specVersion: SPEC_VERSION,
        ...(this.o.fileKey && { fileKey: this.o.fileKey }),
      }));
    };
    s.onmessage = (e) => this.onMessage(s, e.data);
    s.onclose = () => { if (this.sock === s) this.lost(); };
  }

  private onMessage(s: Socket, raw: string) {
    let m: EditorMessage;
    try { m = EditorMessage.parse(JSON.parse(raw)); } catch { return; } // malformed or unknown: ignore
    if (m.type === "helloAck") {
      if (!m.ok) {
        this.stopped = true; // retrying cannot fix a version mismatch
        s.close();
        this.set("refused", { error: m.error ?? "Editor refused the connection" });
        return;
      }
      this.failures = 0;
      this.set("ready", { badge: "compiling" });
      this.o.requestHashTree();
    } else if (m.type === "status") this.o.onChange({ state: this.state, badge: m.state, error: m.issues?.[0]?.message });
    else if (m.type === "error") this.o.onChange({ state: this.state, badge: "error", error: m.message });
    else if (m.type === "resend") this.o.onResend(m.ids);
  }

  private lost() {
    this.sock = null;
    if (this.stopped) return;
    const wasReady = this.state === "ready";
    this.set("disconnected");
    if (wasReady) this.port = this.o.ports.length - 1; // re-sweep from the first port after a back-off
    // try the next port at once; after a full sweep back off (0.5s doubling, max 8s)
    if (this.port + 1 < this.o.ports.length) { this.port++; this.connect(); return; }
    this.port = 0;
    const delay = Math.min(500 * 2 ** this.failures++, 8000);
    this.timer = this.o.timers.set(() => this.connect(), delay);
  }
}
