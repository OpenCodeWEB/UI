/**
 * gdbx-directory.ts — Sovereign persistent user directory + presence.
 *
 * Fixes the /U regression: KV free-tier limits (1,000 writes/day,
 * 24 h session TTL, exhausted list budget → /api/users 500) made logged-in
 * users vanish from the directory. The GDBx pool has NO such budgets:
 *
 *   registry  → pocwu/users/<login>     PERMANENT roster entry (never expires)
 *   presence  → pocwu/presence/<login>  refreshed every 60 s while visiting
 *
 * Online = presence clock fresher than 130 s. Everyone who EVER logged in
 * stays listed (online first, offline after) — exactly the pre-regression
 * behavior, now powered by the sovereign mesh (GDBX1-signed, PoW-gated,
 * pool-replicated) instead of Cloudflare KV.
 *
 * Wire protocol (identical to gdbx.pages.dev playground, proven live):
 *   PUT  : WS {type:"put", addr, pubkey, pubkeyHex, deltas[], ts, nonce, diff, hash, sig}
 *          fallback POST https://gdbx-do.xup.workers.dev/sync
 *   READ : GET  https://gdbx-do.xup.workers.dev/sync/:addr?prefix=…
 */

/* ------------------------------------------------------------------ */
/*  Shared portal identity (dedicated .GDBx, registered live)          */
/* ------------------------------------------------------------------ */

const PORTAL = {
  pub: "EJwLw1uSVbcCDYvUZJ7u-Fi6ZOLXBiu3unKAlGperTo.1Cy4hEmJ1VhpiVbG2CZxh4NNNXhWZSIGfNwaCqZJQog",
  priv: "V4SKgabvy_GqG69U69GieTe6CCkVXZgdfE24f_x-rr8",
  pubkeyHex:
    "04109c0bc35b9255b7020d8bd4649eeef858ba64e2d7062bb7ba7280946a5ead3ad42cb8844989d558698956c6d8267187834d3578566522067cdc1a0aa6494288",
  addr: "aeac2ygbljleaiocudsbqijkjrljk2z5nhtq3xtwovu46cfmzqarwju6gq",
};

const WORKER_BASE = "https://gdbx-do.xup.workers.dev";
const WS_URL = "wss://gdbx-do.xup.workers.dev/ws";

const REGISTRY_PREFIX = "pocwu/users/";
const PRESENCE_PREFIX = "pocwu/presence/";
const PRESENCE_FRESH_MS = 130_000;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DirectoryUser {
  login: string;
  id: number;
  avatar: string;
  name: string;
}

export interface DirectoryEntry extends DirectoryUser {
  /** ISO timestamp of the newest signal we have for this user. */
  lastSeenIso: string;
  /** true while a presence beat is younger than PRESENCE_FRESH_MS. */
  online: boolean;
}

interface DeltaEntry {
  key: string;
  value: string;
  clock?: number;
}

/* ------------------------------------------------------------------ */
/*  GDBX1 crypto (pure WebCrypto — matches worker/src/verify.js)       */
/* ------------------------------------------------------------------ */

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj) as string;
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(rec[k])).join(",") + "}";
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let _signKey: CryptoKey | null = null;
async function getSignKey(): Promise<CryptoKey> {
  if (_signKey) return _signKey;
  const [x, y] = PORTAL.pub.split(".");
  _signKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y, d: PORTAL.priv },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return _signKey;
}

async function gdbx1Sign(body: Record<string, unknown>): Promise<string> {
  const m = canonicalJson(body);
  const key = await getSignKey();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m));
  const rawSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, hash);
  return "GDBX1" + JSON.stringify({ m, s: bytesToB64url(new Uint8Array(rawSig)) });
}

async function minePoW(action: string, ts: number): Promise<{ nonce: number; hash: string; diff: number }> {
  const input = `${PORTAL.addr}:${PORTAL.pub}:${action}:${ts}:`;
  for (let nonce = 1; nonce < 500_000; nonce++) {
    const hex = await sha256Hex(input + nonce);
    if (hex.startsWith("00")) return { nonce, hash: hex, diff: 2 };
  }
  throw new Error("PoW timeout");
}

/* ------------------------------------------------------------------ */
/*  Transport (WS preferred, HTTP fallback with backoff)               */
/* ------------------------------------------------------------------ */

let ws: WebSocket | null = null;
let wsOpen = false;
let retryMs = 5000;
let registered = false;

async function ensureRegistered(): Promise<void> {
  if (registered) return;
  try {
    const chk = await fetch(`${WORKER_BASE}/did/${PORTAL.addr}`);
    if (chk.ok) {
      registered = true;
      return;
    }
  } catch {
    /* fallthrough */
  }
  const ts = Date.now();
  const pow = await minePoW("did.register", ts);
  const sig = await gdbx1Sign({ addr: PORTAL.addr, action: "did.register", ts, payload: null });
  const res = await fetch(`${WORKER_BASE}/did`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      addr: PORTAL.addr,
      pubkey: PORTAL.pub,
      pubkeyHex: PORTAL.pubkeyHex,
      ts,
      nonce: pow.nonce,
      diff: pow.diff,
      hash: pow.hash,
      sig,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok && !/already|exists|registered/i.test(data.error || "")) {
    throw new Error(data.error || `register failed (${res.status})`);
  }
  registered = true;
}

function connect(): void {
  if (ws || typeof window === "undefined") return;
  try {
    ws = new WebSocket(`${WS_URL}?addr=${PORTAL.addr}`);
  } catch {
    return;
  }
  ws.onopen = () => {
    wsOpen = true;
    retryMs = 5000;
    try {
      ws?.send(JSON.stringify({ type: "hello", addr: PORTAL.addr }));
    } catch {}
  };
  ws.onclose = () => {
    wsOpen = false;
    ws = null;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 20000);
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {}
  };
}

async function putDeltas(deltas: Array<{ key: string; value: string }>, retries = 0): Promise<void> {
  connect();
  await ensureRegistered();
  const ts = Date.now();
  const pow = await minePoW("sync.put", ts);
  const sig = await gdbx1Sign({
    addr: PORTAL.addr,
    action: "sync.put",
    ts,
    payload: JSON.stringify(deltas),
  });
  const body = {
    type: "put",
    addr: PORTAL.addr,
    pubkey: PORTAL.pub,
    pubkeyHex: PORTAL.pubkeyHex,
    deltas,
    ts,
    nonce: pow.nonce,
    diff: pow.diff,
    hash: pow.hash,
    sig,
  };

  if (ws && wsOpen) {
    try {
      ws.send(JSON.stringify(body));
      return;
    } catch {
      /* fallthrough to HTTP */
    }
  }

  const res = await fetch(`${WORKER_BASE}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);

  if (!res || !res.ok) {
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (retryable && retries < 2) {
      await new Promise((r) => setTimeout(r, (retries + 1) * 3000));
      return putDeltas(deltas, retries + 1);
    }
    // Swallow — directory writes are best-effort like the old KV path.
    console.warn("[gdbx-directory] put failed:", res ? res.status : "network");
  }
}

async function fetchPrefix(prefix: string): Promise<DeltaEntry[]> {
  try {
    const res = await fetch(
      `${WORKER_BASE}/sync/${PORTAL.addr}?prefix=${encodeURIComponent(prefix)}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { entries?: DeltaEntry[] };
    return data.entries || [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * PERMANENT roster entry — every user who ever logs in is written once here
 * and stays visible forever (this is the piece KV could not provide).
 */
export async function upsertUserRegistry(user: DirectoryUser): Promise<void> {
  try {
    const joinedAt = new Date().toISOString();
    await putDeltas([
      {
        key: `${REGISTRY_PREFIX}${user.login}`,
        value: JSON.stringify({ ...user, joinedAt }),
      },
    ]);
  } catch (e) {
    console.warn("[gdbx-directory] registry upsert failed:", e);
  }
}

/** One presence beat — marks this user online for ~130 s. */
export async function heartbeatPresence(user: DirectoryUser): Promise<void> {
  try {
    await putDeltas([
      {
        key: `${PRESENCE_PREFIX}${user.login}`,
        value: JSON.stringify({ ...user, lastSeen: new Date().toISOString() }),
      },
    ]);
  } catch (e) {
    console.warn("[gdbx-directory] presence beat failed:", e);
  }
}

let presenceTimer: ReturnType<typeof setInterval> | null = null;
let presenceUser: DirectoryUser | null = null;

/** Start the 60 s presence loop for a logged-in user (idempotent). */
export function startPresenceLoop(user: DirectoryUser): void {
  presenceUser = user;
  void heartbeatPresence(user);
  if (!presenceTimer) {
    presenceTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (presenceUser) void heartbeatPresence(presenceUser);
    }, 60_000);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => stopPresenceLoop());
    }
  }
}

export function stopPresenceLoop(): void {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
}

export interface FetchedDirectoryEntry {
  login: string;
  id: number;
  avatar: string;
  name: string;
  lastSeenIso: string;
  ageMs: number;
  online: boolean;
}

/**
 * Read the FULL directory from the pool:
 *   roster ∪ presence → everyone who ever logged in,
 *   online flag derived from presence freshness (<130 s).
 */
export async function fetchDirectory(
  maxAgeMs = 365 * 24 * 60 * 60 * 1000,
): Promise<FetchedDirectoryEntry[]> {
  const [rosterEntries, presenceEntries] = await Promise.all([
    fetchPrefix(REGISTRY_PREFIX),
    fetchPrefix(PRESENCE_PREFIX),
  ]);

  interface Agg extends DirectoryUser {
    lastSeenMs: number;
    hasPresence: boolean;
  }
  const byLogin = new Map<string, Agg>();

  for (const e of rosterEntries) {
    try {
      const u = JSON.parse(String(e.value)) as DirectoryUser & { joinedAt?: string };
      if (!u.login) continue;
      byLogin.set(u.login, {
        login: u.login,
        id: u.id ?? 0,
        avatar: u.avatar || "",
        name: u.name || u.login,
        lastSeenMs: e.clock ?? 0,
        hasPresence: false,
      });
    } catch {}
  }

  const now = Date.now();
  for (const e of presenceEntries) {
    if (!e.key.startsWith(PRESENCE_PREFIX)) continue;
    try {
      const u = JSON.parse(String(e.value)) as DirectoryUser & { lastSeen?: string };
      const login = u.login || e.key.slice(PRESENCE_PREFIX.length);
      if (!login) continue;
      const clock = typeof e.clock === "number" ? e.clock : now;
      const existing = byLogin.get(login);
      if (!existing) {
        // presence without roster (older flow) — still list them
        byLogin.set(login, {
          login,
          id: u.id ?? 0,
          avatar: u.avatar || "",
          name: u.name || login,
          lastSeenMs: clock,
          hasPresence: true,
        });
      } else if (clock > existing.lastSeenMs) {
        existing.lastSeenMs = clock;
        existing.hasPresence = true;
      } else {
        existing.hasPresence = true;
      }
    } catch {}
  }

  const out: FetchedDirectoryEntry[] = [];
  for (const u of byLogin.values()) {
    const ageMs = Math.max(0, now - u.lastSeenMs);
    if (ageMs > maxAgeMs && u.hasPresence === false && u.lastSeenMs === 0) continue;
    out.push({
      login: u.login,
      id: u.id,
      avatar: u.avatar,
      name: u.name,
      lastSeenIso: new Date(u.lastSeenMs || now).toISOString(),
      ageMs,
      online: ageMs < PRESENCE_FRESH_MS,
    });
  }
  // online first, then most-recent
  out.sort((a, b) => (a.online !== b.online ? (a.online ? -1 : 1) : a.ageMs - b.ageMs));
  return out;
}
