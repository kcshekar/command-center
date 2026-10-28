import { createServer } from "node:http";
import type { Payload } from "@temporalio/common";
import { EncryptionCodec } from "./encryption-codec.js";

// P1.0b: codec server for the Temporal Web UI, so encrypted payloads are
// readable while debugging. Run it on YOUR machine (`pnpm codec-server`) with
// the DEK of the environment you're inspecting, then set the UI's codec
// endpoint (Settings → Codec Server) to http://localhost:8081.
// Binds to 127.0.0.1 only: it decrypts whatever it's sent, so it must never
// be reachable from the network. Not started by the worker.
const PORT = Number(process.env.CODEC_SERVER_PORT ?? 8081);
const ORIGINS = new Set((process.env.CODEC_CORS_ORIGINS ?? "http://localhost:8233").split(",").map((o) => o.trim()));

// The UI sends Payloads as JSON with base64 bytes: { metadata: { k: b64 }, data: b64 }.
type JsonPayload = { metadata?: Record<string, string>; data?: string };
const fromJson = (p: JsonPayload): Payload => ({
  metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v, "base64")])),
  data: p.data === undefined ? undefined : Buffer.from(p.data, "base64"),
});
const toJson = (p: Payload): JsonPayload => ({
  metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v as Uint8Array).toString("base64")])),
  data: p.data ? Buffer.from(p.data).toString("base64") : undefined,
});

const codec = await EncryptionCodec.create();

createServer(async (req, res) => {
  const origin = req.headers.origin ?? "";
  if (ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Namespace, Authorization");
    res.setHeader("Access-Control-Allow-Private-Network", "true"); // Chrome: remote UI → localhost
    res.setHeader("Vary", "Origin");
  } else if (origin) {
    return void res.writeHead(403).end();
  }
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const op = req.method === "POST" && (req.url === "/decode" || req.url === "/encode") ? req.url.slice(1) : null;
  if (!op) return void res.writeHead(404).end();
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payloads = ((JSON.parse(body) as { payloads?: JsonPayload[] }).payloads ?? []).map(fromJson);
    const out = op === "decode" ? await codec.decode(payloads) : await codec.encode(payloads);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ payloads: out.map(toJson) }));
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err).slice(0, 200) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`codec server on http://127.0.0.1:${PORT} (origins: ${[...ORIGINS].join(", ")})`));
