import type { PaseoApi } from "@getpaseo/client";
import { LEASE_MS, type Suggestion } from "../shared/contracts";
import { eligible, type Message } from "./context";
import { readContext } from "./history";
import { trace } from "./diagnostics";

type Completion = {
  turnId: string;
  workspaceId?: string;
  at: number;
  attempted: boolean;
  state: Suggestion;
  controller?: AbortController;
  phase?: string;
};
type Lease = { agentId: string; expires: number };
const empty = (status: Suggestion["status"] = "none"): Suggestion => ({
  status,
  turnId: null,
  text: null,
  lastUserMessageAt: null,
});
const TTL_MS = 15 * 60_000;

export class FollowUpService {
  private completions = new Map<string, Completion>();
  private leases = new Map<string, Lease>();
  private queue: (() => Promise<void>)[] = [];
  private running = false;
  private enabled = false;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly generate: (messages: Message[], signal: AbortSignal) => Promise<string | null>,
    private readonly now = Date.now,
  ) {
    this.timer = setInterval(() => this.sweep(), 3_000);
    this.timer.unref?.();
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled && !this.disposed;
    trace("settings", { enabled: this.enabled });
    if (!this.enabled) {
      for (const id of this.completions.keys()) this.invalidate(id);
      this.leases.clear();
    }
  }
  completed(agentId: string, turnId: string, paseo: PaseoApi, workspaceId?: string) {
    if (this.disposed || !this.enabled) return;
    this.sweep();
    if (this.completions.get(agentId)?.turnId === turnId) return;
    this.invalidate(agentId);
    if (this.completions.size >= 256) {
      const oldest = this.completions.keys().next().value!;
      this.invalidate(oldest);
      this.completions.delete(oldest);
    }
    const completion: Completion = {
      turnId,
      workspaceId,
      at: this.now(),
      attempted: false,
      state: empty(),
    };
    this.completions.set(agentId, completion);
    this.phase(agentId, completion, "waiting-for-demand");
    this.schedule(agentId, completion, paseo);
  }
  private phase(agentId: string, completion: Completion, phase: string) {
    if (completion.phase === phase) return;
    completion.phase = phase;
    trace(phase, { agentId, turnId: completion.turnId });
  }
  invalidate(agentId: string, expected?: Completion, reason = "canceled") {
    const completion = this.completions.get(agentId);
    if (!completion || (expected && completion !== expected)) return;
    completion.controller?.abort();
    completion.state = empty();
    // Retain the tombstone so a repeated event or another client cannot rerun this turn.
    completion.attempted = true;
    this.phase(agentId, completion, reason);
  }
  archiveWorkspace(workspaceId: string) {
    for (const [agentId, completion] of this.completions) {
      if (completion.workspaceId === workspaceId) this.invalidate(agentId, completion);
    }
  }
  release(agentId: string, leaseId: string) {
    if (this.leases.get(leaseId)?.agentId !== agentId) return;
    this.leases.delete(leaseId);
    trace("chat-demand-released", { agentId });
    if (!this.hasDemand(agentId)) this.invalidate(agentId);
  }
  private hasDemand(agentId: string) {
    return [...this.leases.values()].some(
      (lease) => lease.agentId === agentId && lease.expires > this.now(),
    );
  }
  private sweep() {
    for (const [id, lease] of this.leases)
      if (lease.expires <= this.now()) this.release(lease.agentId, id);
    for (const [id, completion] of this.completions)
      if (this.now() - completion.at > TTL_MS) {
        this.invalidate(id);
        this.completions.delete(id);
      }
  }
  async demand(agentId: string, leaseId: string, paseo: PaseoApi): Promise<Suggestion> {
    if (!this.enabled || this.disposed) return empty("disabled");
    this.sweep();
    if (!this.leases.has(leaseId) && this.leases.size >= 128) return empty("unavailable");
    const previous = this.leases.get(leaseId);
    if (previous && previous.agentId !== agentId) this.release(previous.agentId, leaseId);
    this.leases.set(leaseId, { agentId, expires: this.now() + LEASE_MS });
    if (!previous) trace("chat-demand-established", { agentId });
    const completion = this.completions.get(agentId);
    if (!completion) return empty();
    this.schedule(agentId, completion, paseo);
    if (completion.state.status !== "ready") return completion.state;
    try {
      const latest = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (
        !this.valid(agentId, completion) ||
        !eligible(latest) ||
        latest.lastUserMessageAt !== completion.state.lastUserMessageAt
      ) {
        this.invalidate(agentId, completion);
        return empty();
      }
      return { ...completion.state };
    } catch {
      return empty("unavailable");
    }
  }
  private valid(agentId: string, completion: Completion) {
    return (
      this.enabled &&
      !this.disposed &&
      this.completions.get(agentId) === completion &&
      !completion.controller?.signal.aborted &&
      this.hasDemand(agentId)
    );
  }
  private schedule(agentId: string, completion: Completion, paseo: PaseoApi) {
    if (completion.attempted || !this.hasDemand(agentId)) return;
    completion.attempted = true;
    if (this.queue.length >= 16) {
      completion.state = empty("unavailable");
      return;
    }
    completion.controller = new AbortController();
    completion.state = { ...empty("pending"), turnId: completion.turnId };
    this.queue.push(async () => {
      try {
        if (!this.valid(agentId, completion)) return;
        const handle = paseo.agents.ref(agentId);
        const before = (await handle.refresh())?.agent;
        if (!this.valid(agentId, completion)) return;
        // The turn-ended hook can precede the foreground snapshot's transition to idle.
        // Retry observation on the next demand heartbeat, without spending a model attempt.
        if (
          before?.status === "running" &&
          (!before.activeTurn || before.activeTurn.turnId === completion.turnId) &&
          !before.internal &&
          !before.archivedAt &&
          !before.pendingPermissions.length &&
          this.now() - completion.at < 10_000
        ) {
          completion.attempted = false;
          completion.state = { ...empty("pending"), turnId: completion.turnId };
          this.phase(agentId, completion, "waiting-for-idle");
          return;
        }
        const snapshotDetails = {
          agentId,
          status: before?.status ?? "missing",
          activeTurn: before?.activeTurn?.turnId ?? null,
          permissions: before?.pendingPermissions.length ?? 0,
        };
        if (!eligible(before)) {
          trace("ineligible-snapshot", snapshotDetails);
          this.invalidate(agentId, completion, "ineligible");
          return;
        }
        this.phase(agentId, completion, "reading-context");
        const messages = await readContext(
          handle.timeline,
          completion.turnId,
          completion.controller!.signal,
        );
        if (!this.valid(agentId, completion)) return;
        if (!messages.length) {
          this.invalidate(agentId, completion, "context-unavailable");
          return;
        }
        this.phase(agentId, completion, "generating");
        const text = await this.generate(messages, completion.controller!.signal);
        if (!this.valid(agentId, completion)) return;
        const after = (await handle.refresh())?.agent;
        if (
          !this.valid(agentId, completion) ||
          !eligible(after) ||
          after.lastUserMessageAt !== before.lastUserMessageAt
        ) {
          this.invalidate(agentId, completion);
          return;
        }
        completion.state = text
          ? {
              status: "ready",
              text,
              turnId: completion.turnId,
              lastUserMessageAt: after.lastUserMessageAt,
            }
          : empty();
        this.phase(agentId, completion, text ? "ready" : "no-suggestion");
      } catch {
        if (this.valid(agentId, completion)) {
          completion.state = empty("unavailable");
          this.phase(agentId, completion, "generation-unavailable");
        }
      }
    });
    void this.drain();
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.disposed && this.queue.length) await this.queue.shift()!();
    } finally {
      this.running = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.setEnabled(false);
    this.queue = [];
    clearInterval(this.timer);
    this.completions.clear();
  }
}
