import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { vi } from "vite-plus/test";
export function agent(patch: Partial<PaseoAgent> = {}): PaseoAgent {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    provider: "codex",
    cwd: "/tmp",
    model: null,
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:01:00Z",
    lastUserMessageAt: "2026-10-25T00:00:30Z",
    status: "idle",
    activeTurn: null,
    pendingPermissions: [],
    internal: false,
    archivedAt: null,
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    persistence: null,
    title: null,
    labels: {},
    ...patch,
  } as PaseoAgent;
}
export function entry(type: string, text: string, seqEnd: number, turnId = "turn-1") {
  return { item: { type, text }, seqEnd, turnId };
}
export function api(snapshot = agent()) {
  const refresh = vi.fn(async () => ({ agent: snapshot }));
  const refetch = vi.fn(async () => ({
    entries: [
      entry("user_message", "Explain this change", 1),
      entry("assistant_message", "The change makes requests cancelable.", 2),
    ],
  }));
  const ref = vi.fn(() => ({ refresh, timeline: { refetch } }));
  return { paseo: { agents: { ref } } as unknown as PaseoApi, refresh, refetch };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
