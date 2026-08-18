/**
 * GunX global graph client — community presence via the OpenCodeWEB open
 * source project GunX (github.com/OpenCodeWEB/GunX, relay wss://gunx.pages.dev/gun).
 *
 * The /U Users directory reads (and writes) the public user registry at the
 * global soul `os/users`:
 *
 *   os/users/<login> = {
 *     login, name, avatar, id,      // public GitHub profile data
 *     joinedAt,                     // first time this user joined the network
 *     lastSeen                      // heartbeat timestamp (flat, scalar)
 *   }
 *
 * Presence contract (GunX):
 * - Every value in the graph is FLAT (no nested objects/arrays).
 * - A user is ONLINE when `lastSeen` is within ONLINE_WINDOW_MS.
 * - Heartbeat writers: the portal (browser) + the OS bridge keepalive, so
 *   anyone in the network — not just KV sessions on this domain — shows up.
 */
import Gun from "gun";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/** Global GunX relay (production graph). Override via VITE_GUNX_RELAY_URLS. */
const GUNX_RELAY_URLS = (
  import.meta.env.VITE_GUNX_RELAY_URLS ||
  "wss://gunx.pages.dev/gun"
)
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

/** Users registry soul on the GunX graph */
export const GUNX_USERS_KEY = "os/users";

/** A user is considered online if their heartbeat is fresher than this. */
export const ONLINE_WINDOW_MS = 120_000;

/** How often a logged-in visitor publishes a heartbeat (while visible). */
export const PRESENCE_INTERVAL_MS = 45_000;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface GunxUserRecord {
  login: string;
  name?: string;
  avatar?: string;
  id?: number;
  joinedAt?: string;
  lastSeen?: string | number;
}

/* ------------------------------------------------------------------ */
/*  Singleton                                                          */
/* ------------------------------------------------------------------ */

let _gun: ReturnType<typeof Gun> | null = null;

/** Get or create the GunX client (separate from the local-relay client). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getGunx(): any {
  if (!_gun) {
    _gun = Gun({
      localStorage: true,
      radisk: true,
      peers: GUNX_RELAY_URLS,
    });
  }
  return _gun;
}

/* ------------------------------------------------------------------ */
/*  Presence helpers                                                   */
/* ------------------------------------------------------------------ */

export function isOnline(record: Pick<GunxUserRecord, "lastSeen">): boolean {
  const t = toTs(record.lastSeen);
  return t > 0 && Date.now() - t <= ONLINE_WINDOW_MS;
}

function toTs(v: string | number | undefined): number {
  if (!v) return 0;
  const t = typeof v === "number" ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/* ------------------------------------------------------------------ */
/*  Graph ops                                                          */
/* ------------------------------------------------------------------ */

/**
 * Subscribe to the whole GunX user registry.
 * `onData` receives a map login → record on every live change.
 * Returns an unsubscribe function.
 */
export function subscribeGunxUsers(
  onData: (users: Record<string, GunxUserRecord>) => void,
): () => void {
  const gun = getGunx();
  const node = gun.get(GUNX_USERS_KEY);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const off = node.map().on((value: any, key: string) => {
    if (!value || typeof value !== "object") return;
    const record = value as GunxUserRecord;
    if (!record.login) return;
    onData({ [key]: record });
  });

  return () => {
    if (typeof off === "function") off();
  };
}

/** Publish (or refresh) the current visitor's public profile + presence. */
export function publishGunxUser(
  user: Pick<GunxUserRecord, "login" | "name" | "avatar" | "id">,
  joinedAt?: string,
): void {
  const gun = getGunx();
  const payload: GunxUserRecord = {
    login: user.login,
    name: user.name ?? user.login,
    avatar: user.avatar ?? "",
    id: user.id ?? 0,
    joinedAt: joinedAt ?? new Date().toISOString(),
    lastSeen: Date.now(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gun.get(GUNX_USERS_KEY).get(user.login).put(payload as any);
}

/** Touch the heartbeat for an existing registry entry. */
export function publishGunxHeartbeat(login: string): void {
  const gun = getGunx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gun.get(GUNX_USERS_KEY).get(login).get("lastSeen").put(Date.now() as any);
}

/** Number of GunX peers currently connected (diagnostics). */
export function getGunxPeerCount(): number {
  const gun = getGunx();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const peers = gun._?.peers;
  if (!peers) return 0;
  return Object.keys(peers).length;
}
