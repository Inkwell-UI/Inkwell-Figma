import { EditorMessage, PROTOCOL_VERSION, SPEC_VERSION, type PluginMessage } from "@inkwell-ui/spec";
import type { Timers } from "./debounce.js";

export interface Socket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
}
export type State = "disconnected" | "connecting" | "handshaking" | "pending" | "denied" | "ready" | "refused";
export type Badge = "synced" | "compiling" | "error";

export interface ClientOpts {
  ports: readonly number[];
  /** Random 256-bit credential (64 hex), made once and kept in figma.clientStorage; the editor stores only its SHA-256 once the user allowed it. */
  pluginSecret: string;
  /** The Figma file's name, shown in the editor's approval prompt. */
  fileName: string;
  pluginVersion: string;
  fileKey?: string;
  open(url: string): Socket;
  timers: Timers;
  /** Ask the main thread for its hash tree; it answers via client.hashTree(). */
  requestHashTree(): void;
  /** Editor asked for fresh subtrees; main thread answers via client.send(patch). */
  onResend(swfId: string, ids: string[]): void;
  /** Editor lacks these images (only hashes not yet asked for on this connection); main thread answers via client.send(asset). */
  onNeedAssets?(hashes: string[]): void;
  onChange(s: { state: State; badge?: Badge; error?: string }): void;
}

/** Delay before asking again after the editor said `busy` (it prompts at most once a minute) or `timeout` (the user did not answer). */
export const busyDelay = (failures: number) => Math.min(5000 * 2 ** failures, 60000);

/** What the plugin window shows for a state (the editor's `error` text is appended when there is one). */
export function statusText(s: { state: State; badge?: Badge; error?: string }): string {
  const base = {
    disconnected: "Disconnected", connecting: "Connecting...", handshaking: "Connecting...",
    pending: "Waiting for approval in the editor", denied: "Denied", refused: "Refused",
    ready: s.badge ?? "Connected",
  }[s.state];
  return s.error ? `${base}: ${s.error}` : base;
}

/** Plugin-side protocol: port scan, hello/helloAck (approved by the user in the editor on first use), backoff reconnect, hash tree on (re)connect. */
export class SyncClient {
  state: State = "disconnected";
  private sock: Socket | null = null;
  private port = 0; // index into ports
  private failures = 0;
  private timer: unknown;
  private stopped = true;
  private holdOff = 0; // set when the editor said busy/timeout: the next connect waits this long on the same port
  private badges = new Map<string, Badge>();
  private asked = new Set<string>(); // image hashes already requested on this connection: each is sent at most once
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
    const url = `ws://localhost:${this.o.ports[this.port]}/`;
    const s = this.o.open(url);
    this.sock = s;
    this.set("connecting");
    s.onopen = () => {
      this.set("handshaking");
      s.send(JSON.stringify({
        type: "hello", pluginVersion: this.o.pluginVersion, protocolVersion: PROTOCOL_VERSION, specVersion: SPEC_VERSION,
        pluginSecret: this.o.pluginSecret, fileName: this.o.fileName,
        ...(this.o.fileKey && { fileKey: this.o.fileKey }),
      }));
    };
    s.onmessage = (e) => this.onMessage(s, e.data);
    s.onclose = () => { if (this.sock === s) this.lost(); };
  }

  private onMessage(s: Socket, raw: string) {
    let m: EditorMessage;
    try { m = EditorMessage.parse(JSON.parse(raw)); } catch { return; } // malformed or unknown: ignore
    if (m.type === "pending") this.set("pending"); // the user is being asked; the editor accepts nothing from us until helloAck
    else if (m.type === "denied") {
      if (m.reason === "busy" || m.reason === "timeout") {
        this.holdOff = m.reason === "timeout" ? 60000 : busyDelay(this.failures++);
        this.set("denied", { error: m.reason === "busy" ? "The editor is busy with another request; trying again shortly" : "No answer in the editor; asking again in a minute" });
      } else {
        this.stopped = true; // the user said no: do not pester (run the plugin again to ask again)
        this.set("denied", { error: `${m.reason === "denied" ? "you denied this plugin in the editor" : m.reason}. Run the plugin again to ask again` });
      }
      s.close();
    } else if (m.type === "helloAck") {
      if (!m.ok) {
        this.stopped = true; // retrying cannot fix a version mismatch
        s.close();
        this.set("refused", { error: m.error ?? "Editor refused the connection" });
        return;
      }
      this.failures = 0;
      this.badges.clear();
      this.asked.clear();
      this.set("ready", { badge: "compiling" });
      this.o.requestHashTree();
    } else if (m.type === "status") {
      // per-SWF states roll up: error beats compiling beats synced
      this.badges.set(m.swfId ?? "", m.state);
      const all = [...this.badges.values()];
      const badge = all.includes("error") ? "error" : all.includes("compiling") ? "compiling" : "synced";
      this.o.onChange({ state: this.state, badge, error: m.issues?.[0]?.message });
    }
    else if (m.type === "error") this.o.onChange({ state: this.state, badge: "error", error: m.message });
    else if (m.type === "resend") this.o.onResend(m.swfId, m.ids);
    else if (m.type === "needAssets") {
      const fresh = [...new Set(m.hashes)].filter((h) => !this.asked.has(h));
      for (const h of fresh) this.asked.add(h);
      if (fresh.length) this.o.onNeedAssets?.(fresh);
    }
  }

  private lost() {
    this.sock = null;
    if (this.stopped) return;
    if (this.holdOff) { // keep the "denied (busy / timeout)" state shown while waiting
      const ms = this.holdOff;
      this.holdOff = 0;
      this.timer = this.o.timers.set(() => this.connect(), ms);
      return;
    }
    const wasReady = this.state === "ready";
    this.set("disconnected");
    if (wasReady) this.port = this.o.ports.length - 1; // re-sweep from the first port after a back-off
    // try the next port at once; after a full sweep back off (0.5s doubling, max 8s)
    if (this.port + 1 < this.o.ports.length) { this.port++; this.connect(); return; }
    this.port = 0;
    // a whole sweep failed: a browser WebSocket cannot say why
    if (!wasReady) this.set("disconnected", { error: "Cannot reach the editor. Is it running? Retrying." });
    const delay = Math.min(500 * 2 ** this.failures++, 8000);
    this.timer = this.o.timers.set(() => this.connect(), delay);
  }
}
