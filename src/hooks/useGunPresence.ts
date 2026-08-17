/**
 * useGunPresence — keeps the signed-in visitor visible in the GunX network.
 *
 * Mounted once in <Layout />: while a GitHub-authenticated user has the
 * portal open, their public profile is published to the GunX global graph
 * (os/users/<login>) and a heartbeat refreshes `lastSeen` every 45 s.
 *
 * Online/offline on the /U page is derived from heartbeat freshness, so the
 * directory reflects the whole network — not only KV sessions on this domain.
 */
import { useEffect, useRef } from "react";
import { useAuth } from "../contexts/AuthContext";
import {
  PRESENCE_INTERVAL_MS,
  publishGunxHeartbeat,
  publishGunxUser,
} from "../lib/gunx";

export function useGunPresence(): void {
  const { user } = useAuth();
  const login = user?.login ?? null;
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!login || !user) return;

    // Join: publish full profile (joinedAt is only set on first publish).
    publishGunxUser({
      login: user.login,
      name: user.name,
      avatar: user.avatar,
      id: user.id,
    });

    const beat = () => {
      if (!document.hidden) publishGunxHeartbeat(login);
    };
    const onVisible = () => {
      if (!document.hidden) {
        publishGunxHeartbeat(login);
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    timerRef.current = window.setInterval(beat, PRESENCE_INTERVAL_MS);

    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login]);
}
