"use client";

import { ConvexReactClient } from "convex/react";
import type { Watch } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore } from "react";
import { mirrorConfigured, mirrorUrl } from "./api";

const MirrorContext = createContext<ConvexReactClient | null>(null);

let sharedClient: ConvexReactClient | null | undefined;

function browserMirrorClient(): ConvexReactClient | null {
  if (sharedClient !== undefined) return sharedClient;
  if (!mirrorConfigured || typeof window === "undefined") {
    sharedClient = null;
    return sharedClient;
  }
  try {
    sharedClient = new ConvexReactClient(mirrorUrl);
  } catch {
    sharedClient = null;
  }
  return sharedClient;
}

const neverChanges = () => () => undefined;
const noClient = () => null;

export function MirrorProvider({ children }: { children: React.ReactNode }) {
  const client = useSyncExternalStore(neverChanges, browserMirrorClient, noClient);
  return <MirrorContext.Provider value={client}>{children}</MirrorContext.Provider>;
}

export function useMirrorClient() {
  return useContext(MirrorContext);
}

export type MirrorQueryResult<value> = {
  configured: boolean;
  connected: boolean;
  data: value | undefined;
  error: Error | null;
};

type Snapshot<value> = { data: value | undefined; error: Error | null };

const emptySnapshot: Snapshot<never> = { data: undefined, error: null };
const serverSnapshot = () => emptySnapshot;

function useWatchSnapshot<value>(watch: Watch<value> | null): Snapshot<value> {
  const cache = useRef<{ raw: unknown; snapshot: Snapshot<value> }>({
    raw: undefined,
    snapshot: emptySnapshot,
  });

  const getSnapshot = useCallback(() => {
    if (watch === null) {
      if (cache.current.snapshot !== emptySnapshot) {
        cache.current = { raw: undefined, snapshot: emptySnapshot };
      }
      return cache.current.snapshot;
    }
    let raw: value | undefined;
    try {
      raw = watch.localQueryResult();
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error("The mirror query failed");
      if (cache.current.snapshot.error?.message !== error.message) {
        cache.current = { raw: undefined, snapshot: { data: undefined, error } };
      }
      return cache.current.snapshot;
    }
    if (!Object.is(cache.current.raw, raw) || cache.current.snapshot.error !== null) {
      cache.current = { raw, snapshot: { data: raw, error: null } };
    }
    return cache.current.snapshot;
  }, [watch]);

  const subscribe = useCallback(
    (onChange: () => void) => (watch === null ? () => undefined : watch.onUpdate(onChange)),
    [watch],
  );

  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}

export function useMirrorQuery<query extends FunctionReference<"query">>(
  reference: query,
  args: FunctionArgs<query> | null,
): MirrorQueryResult<FunctionReturnType<query>> {
  const client = useMirrorClient();
  const serializedArgs = useMemo(() => (args === null ? null : JSON.stringify(args)), [args]);
  const watch = useMemo(
    () =>
      client === null || serializedArgs === null
        ? null
        : client.watchQuery(reference, JSON.parse(serializedArgs)),
    [client, reference, serializedArgs],
  );
  const snapshot = useWatchSnapshot<FunctionReturnType<query>>(watch);
  return { configured: mirrorConfigured, connected: client !== null, ...snapshot };
}

export function useMirrorMutation<mutation extends FunctionReference<"mutation">>(reference: mutation) {
  const client = useMirrorClient();
  return useCallback(
    async (args: FunctionArgs<mutation>): Promise<FunctionReturnType<mutation>> => {
      if (client === null) throw new Error("The Sowmorrow mirror is not configured");
      return client.mutation(reference, args);
    },
    [client, reference],
  );
}
