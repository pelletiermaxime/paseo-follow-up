import type { PaseoAgent, PaseoAgentListResult, PaseoApi } from "@getpaseo/client";

type Observer = {
  host(serverId: string): void;
  upsert(agent: PaseoAgent): void;
  remove(agentId: string): void;
  reset(): void;
};

export function observeAgents(paseo: PaseoApi, observer: Observer): () => void {
  let disposed = false;
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const cleanup: (() => void)[] = [];
  const pages = new Map<number, Set<string>>();

  function reset() {
    generation++;
    cleanup
      .splice(0)
      .reverse()
      .forEach((remove) => remove());
    pages.clear();
    observer.reset();
  }
  function restart() {
    if (disposed) return;
    reset();
    clearTimeout(retry);
    retry = setTimeout(() => void observe(), 5_000);
  }
  function removeIfAbsent(agentId: string) {
    if (![...pages.values()].some((ids) => ids.has(agentId))) observer.remove(agentId);
  }
  async function observe() {
    const current = ++generation;
    const active = () => !disposed && current === generation;
    try {
      const directory = await paseo.hosts.list();
      if (!active()) return;
      observer.host(directory.self.serverId);
      let cursor: string | undefined;
      let pageIndex = 0;
      const cursors = new Set<string>();
      do {
        const result = await paseo.agents.list({
          scope: "active",
          filter: { includeArchived: false, includeInternal: false },
          page: { limit: 100, ...(cursor ? { cursor } : {}) },
          subscribe: {},
        });
        const subscription = result.subscription;
        if (!active()) {
          await subscription.release().catch(() => {});
          return;
        }
        const page = pageIndex++;
        pages.set(page, new Set());
        cleanup.push(() => {
          void subscription.release().catch(() => {});
        });
        const snapshot = (value: PaseoAgentListResult) => {
          if (!active()) return;
          const previous = pages.get(page)!;
          pages.set(page, new Set(value.entries.map((entry) => entry.agent.id)));
          value.entries.forEach((entry) => observer.upsert(entry.agent));
          previous.forEach(removeIfAbsent);
        };
        const unsubscribe = subscription.subscribe({
          snapshot,
          update: (message) => {
            if (!active() || message.type !== "agent_update") return;
            if (message.payload.kind === "upsert") {
              pages.get(page)!.add(message.payload.agent.id);
              observer.upsert(message.payload.agent);
            } else {
              pages.get(page)!.delete(message.payload.agentId);
              removeIfAbsent(message.payload.agentId);
            }
          },
          error: () => {
            if (active()) restart();
          },
        });
        if (!active()) {
          unsubscribe();
          return;
        }
        cleanup.push(unsubscribe);
        // subscribe() immediately supplies the current snapshot and buffered updates. Reapplying
        // ready's older bootstrap snapshot here would resurrect entries those updates removed.
        await subscription.ready;
        if (!active()) return;
        cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Repeated agent-list cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } catch {
      if (active()) restart();
    }
  }
  void observe();
  return () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(retry);
    reset();
  };
}
