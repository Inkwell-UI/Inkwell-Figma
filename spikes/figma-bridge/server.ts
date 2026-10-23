import { WebSocketServer } from "ws";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

// Figma plugin iframes are sandboxed with a `null` origin, so the browser sends `Origin: null`.
// Any sandboxed iframe on any website also sends "null", so the origin check only filters real web
// origins; the session token is the actual defence. No Origin header = non-browser client (token still required).
const ALLOWED_ORIGINS = new Set<string | undefined>([undefined, "null"]);

export function startServer(port = 8787, token = randomBytes(24).toString("hex")) {
  const wss = new WebSocketServer({
    host: "127.0.0.1", // never 0.0.0.0
    port,
    verifyClient: ({ origin, req }, done) => {
      if (!ALLOWED_ORIGINS.has(origin)) return done(false, 403, "bad origin");
      const given = Buffer.from(new URL(req.url ?? "/", "ws://x").searchParams.get("token") ?? "");
      const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return done(false, 401, "bad token");
      done(true);
    },
  });
  const received: any[] = [];
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(1003, "json only"); }
      received.push(msg);
      console.log("[recv]", JSON.stringify(msg));
      if (msg.type === "hello") ws.send(JSON.stringify({ type: "helloAck", ok: true }));
    });
  });
  return { wss, token, received, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = startServer(Number(process.env.PORT ?? 8787));
  console.log(`listening ws://127.0.0.1:${(s.wss.address() as any).port}\nTOKEN: ${s.token}`);
}
