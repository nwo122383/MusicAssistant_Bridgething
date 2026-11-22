import { useCallback, useEffect, useRef, useState } from "react";
import type { Player } from "../types";
import type { MassClient } from "../lib/MassClient";
import { stepVolumeTarget, type VolumeTarget } from "../lib/playerVolume";

type Session = {
  cancelled: boolean;
  reading: boolean;
  sending: boolean;
  expired: boolean;
  changes: number[];
  target?: VolumeTarget;
  level?: number;
  pending?: VolumeTarget;
  debounce?: ReturnType<typeof setTimeout>;
  hide?: ReturnType<typeof setTimeout>;
};

function cancel(session?: Session): void {
  if (!session) return;
  session.cancelled = true;
  clearTimeout(session.debounce);
  clearTimeout(session.hide);
}

export function usePlayerVolume({ client, player, players = [], enabled, connectionKey, individual = false, nativeId = false, ensureConnected, onError }: {
  client: Pick<MassClient, "getVolumeTarget" | "setVolume">;
  player?: Player;
  players?: Player[];
  enabled: boolean;
  connectionKey: string;
  individual?: boolean;
  nativeId?: boolean;
  ensureConnected: () => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const [volume, setVolume] = useState<number>();
  const sessionRef = useRef<Session | undefined>(undefined);
  const latest = useRef({ client, player, enabled, individual, nativeId, ensureConnected, onError });
  latest.current = { client, player, enabled, individual, nativeId, ensureConnected, onError };
  const related: Player[] = [];
  let member = player;
  while (member && !related.includes(member)) {
    related.push(member);
    const currentId = member.player_id;
    const parentId = [member.active_group, member.synced_to].find(id => id && id !== currentId);
    member = players.find(p => p.player_id === parentId);
  }
  const membership = JSON.stringify(related.map(p => [p.player_id, p.active_group, p.synced_to, p.type, [...(p.group_members ?? p.group_childs ?? [])].sort()]));

  useEffect(() => {
    cancel(sessionRef.current);
    sessionRef.current = undefined;
    setVolume(undefined);
    return () => { cancel(sessionRef.current); sessionRef.current = undefined; };
  }, [client, player?.player_id, enabled, connectionKey, membership, individual, nativeId]);

  const changeVolume = useCallback((change: number) => {
    const options = latest.current;
    if (!options.enabled || !options.player || !Number.isFinite(change)) return;
    let session = sessionRef.current;
    const fail = (current: Session, reason: unknown) => {
      if (current.cancelled) return;
      cancel(current);
      if (sessionRef.current === current) sessionRef.current = undefined;
      setVolume(undefined);
      latest.current.onError(reason instanceof Error ? reason.message : "Unable to change volume");
    };
    const hide = (current: Session) => {
      clearTimeout(current.hide);
      current.expired = false;
      current.hide = setTimeout(() => {
        setVolume(undefined);
        current.expired = true;
        if (!current.reading && !current.sending && !current.debounce && current.pending === undefined) sessionRef.current = undefined;
      }, 3000);
    };
    // A slow Bluetooth write must finish before a newer level can overtake it.
    const send = async (current: Session) => {
      if (current.cancelled || current.sending || !current.target || current.pending === undefined) return;
      const target = current.pending;
      current.pending = undefined;
      current.sending = true;
      try { await options.client.setVolume(target, target.level); }
      catch (reason) { fail(current, reason); }
      finally {
        current.sending = false;
        if (!current.cancelled && current.pending !== undefined) void send(current);
        else if (!current.cancelled && current.expired && !current.debounce) sessionRef.current = undefined;
      }
    };
    const update = (current: Session) => {
      if (current.cancelled || !current.target || current.level === undefined) return;
      for (const delta of current.changes) current.target = stepVolumeTarget(current.target, delta);
      current.level = current.target.level;
      current.changes = [];
      setVolume(current.level);
      hide(current);
      clearTimeout(current.debounce);
      current.debounce = setTimeout(() => {
        current.debounce = undefined;
        current.pending = current.target;
        void send(current);
      }, 500);
    };

    if (!session) {
      session = { cancelled: false, reading: true, sending: false, expired: false, changes: [change] };
      sessionRef.current = session;
      const current = session;
      void (async () => {
        try {
          if (!(await options.ensureConnected()) || current.cancelled) return;
          const target = await options.client.getVolumeTarget(options.player!, { individual: options.individual, nativeId: options.nativeId });
          if (current.cancelled) return;
          current.reading = false;
          current.target = target;
          current.level = target.level;
          update(current);
        } catch (reason) { fail(current, reason); }
        finally {
          if (current.reading && !current.cancelled) {
            cancel(current);
            if (sessionRef.current === current) sessionRef.current = undefined;
          }
        }
      })();
    } else {
      session.changes.push(change);
      if (!session.reading) update(session);
    }
  }, []);

  return { volume, changeVolume };
}
