import {
  decodeBase64,
  decodeMessage,
  type ReqMessage,
  isAuthMessage,
  isPingMessage,
  isResMessage,
} from "../shared/protocol";
import type { ServerWebSocket } from "bun";
import { AuthStore } from "./auth-store";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type WsData = {
  subdomain?: string;
  authenticated: boolean;
  userId?: number;
};

type PendingRequest = {
  resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
};

const PORT = Number(Bun.env.PORT ?? "8080");
const DOMAIN = Bun.env.DOMAIN ?? "example.com";
const DB_PATH = Bun.env.DB_PATH ?? "./data/tunnel.db";
const REQUEST_TIMEOUT_MS = Number(Bun.env.REQUEST_TIMEOUT_MS ?? "30000");
const INITIAL_ADMIN_USERNAME = Bun.env.INITIAL_ADMIN_USERNAME;
const INITIAL_ADMIN_PASSWORD = Bun.env.INITIAL_ADMIN_PASSWORD;
const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
mkdirSync(dirname(DB_PATH), { recursive: true });
const authStore = new AuthStore(DB_PATH);

const tunnels = new Map<string, ServerWebSocket<WsData>>();
const pendingRequests = new Map<string, PendingRequest>();

function renderNotFoundPage(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5efe4;
        --card: #fffaf2;
        --ink: #1f1a14;
        --muted: #6d6258;
        --accent: #bf4d28;
        --line: #e8d8c4;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top left, #f9d9b2 0, transparent 28%),
          radial-gradient(circle at bottom right, #f0c39e 0, transparent 24%),
          var(--bg);
        color: var(--ink);
        font-family: Georgia, "Times New Roman", serif;
        padding: 24px;
      }
      main {
        width: min(720px, 100%);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 28px;
        padding: 40px 32px;
        box-shadow: 0 18px 60px rgba(42, 27, 12, 0.12);
      }
      .eyebrow {
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font: 700 12px/1.2 Arial, sans-serif;
        margin-bottom: 14px;
      }
      h1 {
        margin: 0 0 14px;
        font-size: clamp(36px, 6vw, 64px);
        line-height: 0.95;
      }
      p {
        margin: 0;
        font-size: 18px;
        line-height: 1.6;
        color: var(--muted);
        max-width: 56ch;
      }
      .status {
        margin-top: 28px;
        display: inline-block;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 10px 14px;
        font: 600 13px/1.2 Arial, sans-serif;
        color: var(--ink);
        background: #fff;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Tunnel Server</div>
      <h1>${title}</h1>
      <p>${detail}</p>
      <div class="status">HTTP 404</div>
    </main>
  </body>
</html>`;
}

function htmlNotFound(title: string, detail: string): Response {
  return new Response(renderNotFoundPage(title, detail), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function getSubdomainFromHost(hostHeader: string): string {
  const hostWithoutPort = hostHeader.split(":")[0].trim().toLowerCase();
  const bareDomain = DOMAIN.toLowerCase();

  if (hostWithoutPort === bareDomain) return "";
  if (!hostWithoutPort.endsWith(`.${bareDomain}`)) return "";

  return hostWithoutPort.slice(0, -(bareDomain.length + 1));
}

function removeHopByHopHeaders(headers: Record<string, string>): Record<string, string> {
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
  ]);

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, value] = header.split(" ", 2);
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return value.trim() || null;
}

function userIdFromBearer(req: Request): number | null {
  const token = bearerToken(req);
  if (!token) return null;
  return authStore.userIdFromTokenNoTouch(token);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await req.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function bootstrapInitialAdmin(): Promise<void> {
  const username = INITIAL_ADMIN_USERNAME?.trim().toLowerCase();
  const password = INITIAL_ADMIN_PASSWORD;

  if (!username && !password) return;
  if (!username || !password) {
    console.warn("Initial admin not created: set both INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD.");
    return;
  }
  if (!/^[a-z0-9_]{3,32}$/.test(username) || password.length < 8) {
    console.warn("Initial admin not created: invalid username/password format.");
    return;
  }

  const result = await authStore.ensureInitialAdmin(username, password);
  console.log(`Initial admin bootstrap: ${username} (${result})`);
}

Bun.serve<WsData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/api/register" && req.method === "POST") {
      const body = await readJson(req);
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";

      if (!/^[a-z0-9_]{3,32}$/.test(username)) {
        return json({ error: "Username must be 3-32 chars: lowercase letters, numbers, underscore." }, 400);
      }

      if (password.length < 8) {
        return json({ error: "Password must be at least 8 characters." }, 400);
      }

      try {
        const result = await authStore.createUser(username, password);
        return json({ username, role: result.role, token: result.token }, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Registration failed";
        const status = message.includes("exists") ? 409 : 500;
        return json({ error: message }, status);
      }
    }

    if (url.pathname === "/api/token" && req.method === "POST") {
      const body = await readJson(req);
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";

      if (!username || !password) {
        return json({ error: "username and password are required." }, 400);
      }

      try {
        const result = await authStore.createTokenFromCredentials(username, password);
        return json({ username, role: result.role, token: result.token });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Token issue failed";
        return json({ error: message }, 401);
      }
    }

    if (url.pathname === "/api/tokens" && req.method === "GET") {
      const userId = userIdFromBearer(req);
      if (!userId) return json({ error: "Unauthorized" }, 401);
      const tokens = authStore.listTokensByUser(userId);
      return json({ tokens });
    }

    if (url.pathname === "/api/tokens/revoke" && req.method === "POST") {
      const userId = userIdFromBearer(req);
      if (!userId) return json({ error: "Unauthorized" }, 401);

      const body = await readJson(req);
      const token = typeof body?.token === "string" ? body.token.trim() : "";
      if (!token) return json({ error: "token is required." }, 400);

      const revoked = authStore.revokeTokenByValue(userId, token);
      if (!revoked) return json({ error: "Token not found for this account." }, 404);
      return json({ revoked: true });
    }

    if (url.pathname === "/_tunnel_connect") {
      if (server.upgrade(req, { data: { authenticated: false } })) {
        return;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    const host = req.headers.get("host") ?? "";
    const subdomain = getSubdomainFromHost(host);
    if (!subdomain) {
      return htmlNotFound("Unknown Host", `This request host is not mapped under ${DOMAIN}.`);
    }

    const tunnel = tunnels.get(subdomain);
    if (!tunnel) {
      return htmlNotFound("Tunnel Offline", `No active client is connected for ${subdomain}.${DOMAIN}.`);
    }

    const requestId = crypto.randomUUID();
    const bodyBuffer = await req.arrayBuffer();

    const outbound: ReqMessage = {
      type: "REQ",
      id: requestId,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: removeHopByHopHeaders(Object.fromEntries(req.headers.entries())),
      bodyBase64: Buffer.from(bodyBuffer).toString("base64"),
    };

    const responsePromise = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(new Response("Tunnel request timeout", { status: 504 }));
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(requestId, { resolve, timer });
    });

    tunnel.send(JSON.stringify(outbound));
    return responsePromise;
  },
  websocket: {
    open(ws) {
      console.log("Client connected, waiting for AUTH");
    },
    message(ws, message) {
      let data: unknown;
      try {
        data = decodeMessage(message as string | Buffer | ArrayBuffer);
      } catch {
        ws.send(JSON.stringify({ type: "ERROR", message: "Invalid JSON" }));
        return;
      }

      if (!ws.data.authenticated) {
        if (!isAuthMessage(data)) {
          ws.send(JSON.stringify({ type: "ERROR", message: "AUTH required" }));
          ws.close();
          return;
        }

        const userId = authStore.userIdFromToken(data.token);
        if (!userId) {
          ws.send(JSON.stringify({ type: "ERROR", message: "Invalid token" }));
          ws.close();
          return;
        }

        if (!SUBDOMAIN_REGEX.test(data.subdomain)) {
          ws.send(JSON.stringify({ type: "ERROR", message: "Invalid subdomain format" }));
          ws.close();
          return;
        }

        if (!authStore.ensureSubdomainOwnership(userId, data.subdomain)) {
          ws.send(JSON.stringify({ type: "ERROR", message: "Subdomain belongs to another account" }));
          ws.close();
          return;
        }

        if (tunnels.has(data.subdomain)) {
          ws.send(JSON.stringify({ type: "ERROR", message: "Subdomain already in use" }));
          ws.close();
          return;
        }

        ws.data.userId = userId;
        ws.data.subdomain = data.subdomain;
        ws.data.authenticated = true;
        tunnels.set(data.subdomain, ws);
        console.log(`Tunnel active: ${data.subdomain}.${DOMAIN}`);
        return;
      }

      if (isPingMessage(data)) {
        ws.send(JSON.stringify({ type: "PONG", ts: data.ts }));
        return;
      }

      if (!isResMessage(data)) {
        ws.send(JSON.stringify({ type: "ERROR", message: "Unsupported message type" }));
        return;
      }

      const pending = pendingRequests.get(data.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      pendingRequests.delete(data.id);

      const headers = removeHopByHopHeaders(data.headers);
      pending.resolve(
        new Response(decodeBase64(data.bodyBase64), {
          status: data.status,
          headers,
        }),
      );
    },
    close(ws) {
      if (ws.data.subdomain) {
        tunnels.delete(ws.data.subdomain);
        console.log(`Tunnel closed: ${ws.data.subdomain}.${DOMAIN}`);
      }
    },
  },
});

console.log(`Tunnel server listening on :${PORT} for *.${DOMAIN}`);
void bootstrapInitialAdmin();
