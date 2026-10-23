import assert from "node:assert/strict";
import WebSocket from "ws";
import { startServer } from "./server.ts";

const s = startServer(0);
await new Promise((r) => s.wss.once("listening", r));
const port = (s.wss.address() as any).port;
const url = (t: string) => `ws://127.0.0.1:${port}/?token=${t}`;

// resolves "open" or "rejected:<status>"
const tryConnect = (t: string, origin?: string) =>
  new Promise<{ ws?: WebSocket; r: string }>((res) => {
    const ws = new WebSocket(url(t), origin === undefined ? {} : { origin });
    ws.on("open", () => res({ ws, r: "open" }));
    ws.on("unexpected-response", (_q, resp) => res({ r: `rejected:${resp.statusCode}` }));
    ws.on("error", () => {});
  });

try {
  const good = await tryConnect(s.token, "null"); // what Figma sends
  assert.equal(good.r, "open");
  const ack = new Promise<any>((r) => good.ws!.once("message", (d) => r(JSON.parse(d.toString()))));
  good.ws!.send(JSON.stringify({ type: "hello", pluginVersion: "0.0.1", specVersion: "TODO" }));
  assert.deepEqual(await ack, { type: "helloAck", ok: true });
  good.ws!.send(JSON.stringify({ type: "selection", nodes: [{ id: "1:2", name: "A" }] }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.received.length, 2);
  assert.equal(s.received[1].type, "selection");
  good.ws!.close();
  console.log("ok  good token + origin null: hello acked, selection received");

  assert.equal((await tryConnect("wrong", "null")).r, "rejected:401");
  console.log("ok  bad token rejected (401)");
  assert.equal((await tryConnect(s.token, "https://evil.example")).r, "rejected:403");
  console.log("ok  bad origin rejected (403)");
  assert.equal((await tryConnect(s.token)).r, "open");
  console.log("ok  no Origin (non-browser) + good token accepted");
  assert.equal((s.wss.address() as any).address, "127.0.0.1");
  console.log("ok  bound to 127.0.0.1 only");
  console.log("ALL PASSED");
  s.wss.clients.forEach((c) => c.terminate());
  await s.close();
  process.exit(0);
} catch (e) {
  console.error("FAILED", e);
  process.exit(1);
}
