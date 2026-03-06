export type HeaderMap = Record<string, string>;

export type ReqMessage = {
  type: "REQ";
  id: string;
  method: string;
  path: string;
  headers: HeaderMap;
  bodyBase64: string;
};

export type ResMessage = {
  type: "RES";
  id: string;
  status: number;
  headers: HeaderMap;
  bodyBase64: string;
};

export type AuthMessage = {
  type: "AUTH";
  subdomain: string;
  token: string;
};

export type PingMessage = {
  type: "PING";
  ts: number;
};

export type PongMessage = {
  type: "PONG";
  ts: number;
};

export type ErrorMessage = {
  type: "ERROR";
  message: string;
};

export type ClientToServer = AuthMessage | ResMessage | PingMessage;
export type ServerToClient = ReqMessage | PongMessage | ErrorMessage;

export function decodeMessage(input: string | Buffer | ArrayBuffer): unknown {
  const text =
    typeof input === "string"
      ? input
      : input instanceof ArrayBuffer
      ? Buffer.from(input).toString("utf8")
      : Buffer.from(input).toString("utf8");
  return JSON.parse(text);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function isStringRecord(value: unknown): value is HeaderMap {
  const record = asRecord(value);
  if (!record) return false;
  return Object.values(record).every((v) => typeof v === "string");
}

export function isResMessage(value: unknown): value is ResMessage {
  const r = asRecord(value);
  if (!r) return false;
  return (
    r.type === "RES" &&
    typeof r.id === "string" &&
    typeof r.status === "number" &&
    isStringRecord(r.headers) &&
    typeof r.bodyBase64 === "string"
  );
}

export function isAuthMessage(value: unknown): value is AuthMessage {
  const r = asRecord(value);
  if (!r) return false;
  return (
    r.type === "AUTH" &&
    typeof r.subdomain === "string" &&
    typeof r.token === "string"
  );
}

export function isPingMessage(value: unknown): value is PingMessage {
  const r = asRecord(value);
  if (!r) return false;
  return r.type === "PING" && typeof r.ts === "number";
}

export function encodeBase64(data: ArrayBuffer): string {
  return Buffer.from(data).toString("base64");
}

export function decodeBase64(data: string): ArrayBuffer {
  const buf = Buffer.from(data, "base64");
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}
