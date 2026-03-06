import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

export type UserRole = "admin" | "client";

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
};

export type TokenInfo = {
  id: number;
  created_at: string;
  last_used_at: string | null;
};

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issuePlainToken(): string {
  return `tun_${randomBytes(24).toString("base64url")}`;
}

export class AuthStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'client',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_digest TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS subdomains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Backward-compatible migration for existing databases created before roles.
    const columns = this.db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const hasRole = columns.some((c) => c.name === "role");
    if (!hasRole) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'client'");
    }
    this.db.exec("UPDATE users SET role = 'client' WHERE role IS NULL OR role NOT IN ('admin','client')");
  }

  async createUser(username: string, password: string): Promise<{ userId: number; token: string; role: UserRole }> {
    return this.createUserWithRole(username, password, "client");
  }

  async createUserWithRole(
    username: string,
    password: string,
    role: UserRole,
  ): Promise<{ userId: number; token: string; role: UserRole }> {
    const passwordHash = await Bun.password.hash(password);
    const insertUser = this.db.query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id");
    let userId: number;
    try {
      const row = insertUser.get(username, passwordHash, role) as { id: number } | null;
      if (!row) throw new Error("Failed to create user");
      userId = row.id;
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes("unique")) {
        throw new Error("Username already exists");
      }
      throw error;
    }

    const token = this.createTokenForUser(userId);
    return { userId, token, role };
  }

  async createTokenFromCredentials(username: string, password: string): Promise<{ token: string; role: UserRole }> {
    const user = this.db
      .query("SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?")
      .get(username) as UserRow | null;
    if (!user) throw new Error("Invalid username or password");

    const ok = await Bun.password.verify(password, user.password_hash);
    if (!ok) throw new Error("Invalid username or password");

    return { token: this.createTokenForUser(user.id), role: user.role };
  }

  async ensureInitialAdmin(username: string, password: string): Promise<"created" | "promoted" | "exists"> {
    const user = this.db
      .query("SELECT id, role FROM users WHERE username = ?")
      .get(username) as { id: number; role: UserRole } | null;

    if (!user) {
      await this.createUserWithRole(username, password, "admin");
      return "created";
    }

    if (user.role !== "admin") {
      this.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
      return "promoted";
    }

    return "exists";
  }

  userIdFromToken(token: string): number | null {
    const digest = digestToken(token);
    const row = this.db.query("SELECT user_id FROM api_tokens WHERE token_digest = ?").get(digest) as
      | { user_id: number }
      | null;

    if (!row) return null;
    this.db.query("UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token_digest = ?").run(digest);
    return row.user_id;
  }

  userIdFromTokenNoTouch(token: string): number | null {
    const row = this.db.query("SELECT user_id FROM api_tokens WHERE token_digest = ?").get(digestToken(token)) as
      | { user_id: number }
      | null;
    return row?.user_id ?? null;
  }

  ensureSubdomainOwnership(userId: number, subdomain: string): boolean {
    const existing = this.db
      .query("SELECT user_id FROM subdomains WHERE name = ?")
      .get(subdomain) as { user_id: number } | null;

    if (!existing) {
      this.db.query("INSERT INTO subdomains (user_id, name) VALUES (?, ?)").run(userId, subdomain);
      return true;
    }

    return existing.user_id === userId;
  }

  listTokensByUser(userId: number): TokenInfo[] {
    return this.db
      .query("SELECT id, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC")
      .all(userId) as TokenInfo[];
  }

  revokeTokenByValue(userId: number, token: string): boolean {
    const result = this.db
      .query(
        "DELETE FROM api_tokens WHERE user_id = ? AND token_digest = ?",
      )
      .run(userId, digestToken(token));
    return (result.changes ?? 0) > 0;
  }

  private createTokenForUser(userId: number): string {
    const plainToken = issuePlainToken();
    this.db.query("INSERT INTO api_tokens (user_id, token_digest) VALUES (?, ?)").run(userId, digestToken(plainToken));
    return plainToken;
  }
}
