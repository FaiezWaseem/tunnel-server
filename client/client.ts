import {
  decodeBase64,
  decodeMessage,
  encodeBase64,
  isStringRecord,
  type AuthMessage,
} from "../shared/protocol";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type ReqMessage = {
  type: "REQ";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string;
};

type ErrorMessage = {
  type: "ERROR";
  message: string;
};

type AuthApiResponse = {
  token: string;
  username: string;
  role?: "admin" | "client";
  error?: string;
};

type TokensApiResponse = {
  tokens?: Array<{ id: number; created_at: string; last_used_at: string | null }>;
  error?: string;
};

type SessionFile = {
  token?: string;
  username?: string;
  saved_at?: string;
};

function getArg(name: string): string | undefined {
  const idx = Bun.argv.findIndex((arg) => arg === `--${name}`);
  if (idx === -1) return undefined;
  return Bun.argv[idx + 1];
}

function getAnyArg(names: string[]): string | undefined {
  for (let i = 0; i < Bun.argv.length; i += 1) {
    if (names.includes(Bun.argv[i])) return Bun.argv[i + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return Bun.argv.includes(`--${name}`);
}

function printHelp(): void {
  const entryRaw = Bun.argv[1] ?? "tunnel-client";
  const entry = entryRaw.split(/[\\/]/).pop() ?? entryRaw;
  const isCompiled = /\.exe$/i.test(entry) || entry.includes("tunnel-client");
  const usageLine = isCompiled
    ? `${entry} [MODE] [OPTIONS]`
    : "bun run dev:client -- [MODE] [OPTIONS]";

  console.log(`
Tunnel Client

Usage:
  ${usageLine}

Modes (choose one):
  --register                 Register account and return first API token
  --login                    Login and issue a new API token
  --list-tokens              List all tokens for current account
  --revoke-token <TOKEN>     Revoke a specific token
  (no mode)                  Start tunnel connection

Connection options:
  --server <WS_URL>          Tunnel server WebSocket URL
  --api <HTTP_URL>           API base URL for register/login/token ops
  --token <TOKEN>            API token (required for tunnel/list/revoke modes)

Tunnel target options:
  --local <URL>              Local upstream URL (e.g. http://127.0.0.1:3000)
  --port <N> | --p <N> | -p <N>
                             Shortcut for local URL (http://127.0.0.1:<N>)
  --subdomain <NAME>         Custom subdomain; if omitted, auto-generated

Account options:
  --username <NAME>          Username for register/login
  --password <PASS>          Password for register/login

Other:
  --help, -h                 Show this help message

Environment fallbacks:
  TUNNEL_SERVER_URL
  TUNNEL_API_URL
  TUNNEL_AUTH_TOKEN
  TUNNEL_SESSION_FILE
  TUNNEL_LOCAL_URL
  TUNNEL_SUBDOMAIN
  TUNNEL_USERNAME
  TUNNEL_PASSWORD
  TUNNEL_REVOKE_TOKEN

Session behavior:
  After --register / --login, token is saved locally and reused automatically.
  Use --no-save-token to disable writing local session file.
`);
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getConfig(name: string, envKey: string, fallback?: string): string {
  const cli = normalizeOptional(getArg(name));
  if (cli) return cli;
  const envValue = normalizeOptional(Bun.env[envKey]);
  if (envValue) return envValue;
  if (fallback !== undefined) return fallback;
  console.error(`Missing required config --${name} or ${envKey}`);
  process.exit(1);
}

function deriveApiBaseFromServerUrl(urlValue: string): string {
  const url = new URL(urlValue);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function derivePublicHost(serverUrlValue: string, subdomainValue: string): string | undefined {
  try {
    const url = new URL(serverUrlValue);
    const host = url.hostname.trim().toLowerCase();
    if (!host) return undefined;
    return `${subdomainValue}.${host}`;
  } catch {
    return undefined;
  }
}

const isRegisterMode = hasFlag("register");
const isLoginMode = hasFlag("login");
const isListTokensMode = hasFlag("list-tokens");
const revokeTokenValue = normalizeOptional(getArg("revoke-token"));
const isRevokeTokenMode = Boolean(revokeTokenValue);
const isHelpMode = hasFlag("help") || Bun.argv.includes("-h");

if (isHelpMode) {
  printHelp();
  process.exit(0);
}

const selectedModes = [isRegisterMode, isLoginMode, isListTokensMode, isRevokeTokenMode].filter(Boolean).length;
if (selectedModes > 1) {
  console.error("Use only one mode: --register, --login, --list-tokens, or --revoke-token <TOKEN>");
  process.exit(1);
}

const configuredServerUrl = normalizeOptional(getArg("server") ?? Bun.env.TUNNEL_SERVER_URL);
const serverUrl = configuredServerUrl ?? "ws://127.0.0.1:8080/_tunnel_connect";
const configuredApiBase =
  normalizeOptional(getArg("api") ?? Bun.env.TUNNEL_API_URL) ?? deriveApiBaseFromServerUrl(serverUrl);
const configuredSubdomain = normalizeOptional(getArg("subdomain") ?? Bun.env.TUNNEL_SUBDOMAIN);
const configuredSessionFile = normalizeOptional(getArg("session-file") ?? Bun.env.TUNNEL_SESSION_FILE);
const shouldSaveToken = !hasFlag("no-save-token");
const portArgRaw = normalizeOptional(getAnyArg(["--port", "--p", "-p"]));
const localArgRaw = normalizeOptional(getArg("local"));
const localBase = (() => {
  if (localArgRaw) return localArgRaw.replace(/\/$/, "");
  if (portArgRaw) {
    const portNum = Number(portArgRaw);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      console.error(`Invalid port "${portArgRaw}". Expected integer in range 1-65535.`);
      process.exit(1);
    }
    return `http://127.0.0.1:${portNum}`;
  }
  return getConfig("local", "TUNNEL_LOCAL_URL", "http://127.0.0.1:3000").replace(/\/$/, "");
})();
const isSubdomainPinned = Boolean(configuredSubdomain);
let subdomain = configuredSubdomain ?? generateSubdomain();

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const HEARTBEAT_MS = 20000;
const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

function getDefaultSessionFile(): string {
  const appData = Bun.env.APPDATA;
  if (appData) return join(appData, "tunnel-client", "session.json");
  const home = Bun.env.HOME ?? ".";
  return join(home, ".config", "tunnel-client", "session.json");
}

const sessionFile = configuredSessionFile ?? getDefaultSessionFile();

function generateSubdomain(): string {
  return `tun-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureValidSubdomainOrExit(value: string): void {
  if (!SUBDOMAIN_REGEX.test(value)) {
    console.error(
      `Invalid subdomain "${value}". Use lowercase letters, numbers, hyphens; length 3-32, cannot start/end with hyphen.`,
    );
    process.exit(1);
  }
}

function sanitizeForwardHeaders(headers: Record<string, string>): Record<string, string> {
  const blocked = new Set(["host", "connection", "content-length"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const blocked = new Set([
    "connection",
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "keep-alive",
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!blocked.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function isReqMessage(v: unknown): v is ReqMessage {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    r.type === "REQ" &&
    typeof r.id === "string" &&
    typeof r.method === "string" &&
    typeof r.path === "string" &&
    isStringRecord(r.headers) &&
    typeof r.bodyBase64 === "string"
  );
}

function isErrorMessage(v: unknown): v is ErrorMessage {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return r.type === "ERROR" && typeof r.message === "string";
}

function readSessionToken(): string | undefined {
  if (!existsSync(sessionFile)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(sessionFile, "utf8")) as SessionFile;
    return normalizeOptional(parsed.token);
  } catch {
    return undefined;
  }
}

function saveSessionToken(token: string, username: string): void {
  if (!shouldSaveToken) return;
  mkdirSync(dirname(sessionFile), { recursive: true });
  const payload: SessionFile = { token, username, saved_at: new Date().toISOString() };
  writeFileSync(sessionFile, JSON.stringify(payload, null, 2), "utf8");
}

function resolveAuthToken(): string {
  const cli = normalizeOptional(getArg("token"));
  if (cli) return cli;
  const envToken = normalizeOptional(Bun.env.TUNNEL_AUTH_TOKEN);
  if (envToken) return envToken;
  const sessionToken = readSessionToken();
  if (sessionToken) return sessionToken;
  console.error("Missing auth token. Use --token, TUNNEL_AUTH_TOKEN, or run --login / --register first.");
  process.exit(1);
}

async function createOrFetchToken(mode: "register" | "login"): Promise<void> {
  const username = getConfig("username", "TUNNEL_USERNAME").toLowerCase();
  const password = getConfig("password", "TUNNEL_PASSWORD");
  const endpoint = mode === "register" ? "/api/register" : "/api/token";

  const response = await fetch(`${configuredApiBase}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const body = (await response.json()) as AuthApiResponse;
  if (!response.ok || !body.token) {
    console.error(body.error ?? `Failed to ${mode}.`);
    process.exit(1);
  }

  console.log(`${mode === "register" ? "Registered" : "Authenticated"} user: ${body.username}`);
  if (body.role) console.log(`Role: ${body.role}`);
  console.log(`Token: ${body.token}`);
  saveSessionToken(body.token, body.username);
  if (shouldSaveToken) {
    console.log(`Saved token to: ${sessionFile}`);
  }
  console.log("Use this token via --token, TUNNEL_AUTH_TOKEN, or saved session.");
}

async function listTokens(): Promise<void> {
  const token = resolveAuthToken();
  const response = await fetch(`${configuredApiBase}/api/tokens`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as TokensApiResponse;
  if (!response.ok || !body.tokens) {
    console.error(body.error ?? "Failed to list tokens.");
    process.exit(1);
  }

  if (body.tokens.length === 0) {
    console.log("No tokens found.");
    return;
  }

  console.log("Tokens:");
  for (const t of body.tokens) {
    console.log(`- id=${t.id} created_at=${t.created_at} last_used_at=${t.last_used_at ?? "never"}`);
  }
}

async function revokeToken(): Promise<void> {
  const token = resolveAuthToken();
  const targetToken = revokeTokenValue ?? getConfig("target-token", "TUNNEL_REVOKE_TOKEN");
  const response = await fetch(`${configuredApiBase}/api/tokens/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ token: targetToken }),
  });
  const body = (await response.json()) as { revoked?: boolean; error?: string };
  if (!response.ok || !body.revoked) {
    console.error(body.error ?? "Failed to revoke token.");
    process.exit(1);
  }
  console.log("Token revoked.");
}

async function handleRequest(ws: WebSocket, req: ReqMessage): Promise<void> {
  try {
    const upstream = await fetch(`${localBase}${req.path}`, {
      method: req.method,
      headers: sanitizeForwardHeaders(req.headers),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : decodeBase64(req.bodyBase64),
      redirect: "manual",
    });

    const body = await upstream.arrayBuffer();
    ws.send(
      JSON.stringify({
        type: "RES",
        id: req.id,
        status: upstream.status,
        headers: sanitizeResponseHeaders(Object.fromEntries(upstream.headers.entries())),
        bodyBase64: encodeBase64(body),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upstream error";
    ws.send(
      JSON.stringify({
        type: "RES",
        id: req.id,
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
        bodyBase64: Buffer.from(`Upstream error: ${message}`).toString("base64"),
      }),
    );
  }
}

async function connectLoop(): Promise<void> {
  let delay = RECONNECT_MIN_MS;
  const token = resolveAuthToken();

  while (true) {
    let ws: WebSocket | null = null;
    let heartbeat: Timer | null = null;

    try {
      ws = new WebSocket(serverUrl);

      await new Promise<void>((resolve, reject) => {
        ws!.onopen = () => {
          ensureValidSubdomainOrExit(subdomain);
          const auth: AuthMessage = { type: "AUTH", subdomain, token };
          ws!.send(JSON.stringify(auth));
          const publicHost = derivePublicHost(serverUrl, subdomain);

          console.log(`Connected to ${serverUrl}`);
          console.log(`Tunnel requested: ${subdomain}`);
          if (publicHost) {
            console.log(`Public URL: https://${publicHost}`);
          }

          heartbeat = setInterval(() => {
            ws?.send(JSON.stringify({ type: "PING", ts: Date.now() }));
          }, HEARTBEAT_MS);

          resolve();
        };

        ws!.onmessage = (event) => {
          let data: unknown;
          try {
            data = decodeMessage(event.data as string | Buffer | ArrayBuffer);
          } catch {
            console.error("Received invalid JSON from server");
            return;
          }

          if (isErrorMessage(data)) {
            console.error(`Server error: ${data.message}`);
            if (data.message === "Subdomain already in use" && !isSubdomainPinned) {
              subdomain = generateSubdomain();
              console.error(`Retrying with new auto subdomain: ${subdomain}`);
              ws?.close();
            }
            return;
          }

          if (isReqMessage(data)) {
            void handleRequest(ws!, data);
          }
        };

        ws!.onclose = () => reject(new Error("WebSocket closed"));
        ws!.onerror = () => reject(new Error("WebSocket error"));
      });

      await new Promise<never>((_, reject) => {
        ws!.onclose = () => reject(new Error("WebSocket closed"));
        ws!.onerror = () => reject(new Error("WebSocket error"));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Disconnected: ${message}`);
      console.error(`Reconnecting in ${delay}ms...`);
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      ws?.close();
    }
  }
}

if (isRegisterMode) {
  void createOrFetchToken("register");
} else if (isLoginMode) {
  void createOrFetchToken("login");
} else if (isListTokensMode) {
  void listTokens();
} else if (isRevokeTokenMode) {
  void revokeToken();
} else {
  console.log(`Local upstream: ${localBase}`);
  console.log(`Subdomain mode: ${isSubdomainPinned ? "custom" : "auto"}`);
  console.log(`Subdomain: ${subdomain}`);
  void connectLoop();
}
