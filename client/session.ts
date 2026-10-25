import type { PluginClientContext } from "@getpaseo/plugin/client";
import { demandRpc, deliveryRpc, POLL_MS, releaseRpc } from "../shared/contracts";
import type { Composer, ComposerResult } from "./composer";

// Seen turns live for this plugin installation, across navigation/remounts. Eviction is bounded;
// daemon tombstones also prevent regenerating old turns.
export class ComposerSession {
  private disposed = false;
  private remove?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private sourceUser?: string | null;
  private lastDelivery?: string;
  private unsubscribe: () => void;
  constructor(
    private readonly client: PluginClientContext,
    private readonly composer: Composer,
    private readonly serverId: string,
    private readonly agentId: string,
    private readonly leaseId: string,
    private readonly seen: Set<string>,
    private readonly onStatus: (status: string) => void = () => {},
  ) {
    this.unsubscribe = client.paseo.agents.ref(agentId).subscribe((update) => {
      if (
        update.kind === "remove" ||
        update.agent.status !== "idle" ||
        update.agent.activeTurn ||
        update.agent.pendingPermissions.length ||
        update.agent.archivedAt ||
        update.agent.internal ||
        (this.sourceUser !== undefined && update.agent.lastUserMessageAt !== this.sourceUser)
      ) {
        this.revision++;
        this.remove?.();
        this.remove = undefined;
      }
    });
    void this.poll();
  }
  private reportDelivery(turnId: string, status: ComposerResult["status"] | "stale") {
    const delivery = `${turnId}:${status}`;
    if (this.lastDelivery === delivery) return;
    this.lastDelivery = delivery;
    void this.client.rpc(deliveryRpc, { agentId: this.agentId, turnId, status }).catch(() => {});
  }
  private async poll() {
    const revision = this.revision;
    let reservedKey: string | undefined;
    let attemptedOffer = false;
    try {
      const value = await this.client.rpc(demandRpc, {
        agentId: this.agentId,
        leaseId: this.leaseId,
      });
      if (this.disposed) {
        void this.client
          .rpc(releaseRpc, { agentId: this.agentId, leaseId: this.leaseId })
          .catch(() => {});
        return;
      }
      this.onStatus(value.status);
      if (value.status !== "ready") {
        this.remove?.();
        this.remove = undefined;
        this.sourceUser = undefined;
        return;
      }
      const key = `${this.serverId}:${this.agentId}:${value.turnId}`;
      if (!value.text || !value.turnId || this.seen.has(key)) return;
      // Reserve before awaiting so concurrent mounts cannot offer the same turn twice.
      // Only a displayed suggestion or an existing draft permanently consumes this reservation.
      this.seen.add(key);
      reservedKey = key;
      if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
      if (this.sourceUser !== undefined && this.sourceUser !== value.lastUserMessageAt) {
        this.remove?.();
        this.remove = undefined;
        this.sourceUser = undefined;
      }
      const latest = (await this.client.paseo.agents.ref(this.agentId).refresh())?.agent;
      if (
        this.disposed ||
        revision !== this.revision ||
        !latest ||
        latest.status !== "idle" ||
        latest.activeTurn ||
        latest.pendingPermissions.length ||
        latest.archivedAt ||
        latest.internal ||
        latest.lastUserMessageAt !== value.lastUserMessageAt
      ) {
        this.seen.delete(key);
        this.reportDelivery(value.turnId, "stale");
        return;
      }
      this.sourceUser = value.lastUserMessageAt;
      attemptedOffer = true;
      const result = await this.composer.suggestText({
        serverId: this.serverId,
        agentId: this.agentId,
        text: value.text,
      });
      this.reportDelivery(value.turnId, result.status);
      if (result.status === "composer-unavailable" || result.status === "submission-in-progress") {
        // Focus/overlay and submission transitions are temporary. Reuse the cached result;
        // the host still checks the live draft and attachments on every attempt.
        this.seen.delete(key);
      }
      if (result.status === "suggested") {
        if (this.disposed || revision !== this.revision) result.remove();
        else {
          this.remove?.();
          this.remove = () => result.remove();
        }
      }
    } catch {
      if (reservedKey && !attemptedOffer) this.seen.delete(reservedKey);
      if (!this.disposed) this.onStatus("unavailable");
      // Transport/provider errors are intentionally not shown or logged with raw details.
      this.remove?.();
      this.remove = undefined;
    } finally {
      if (!this.disposed) this.timer = setTimeout(() => void this.poll(), POLL_MS);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.unsubscribe();
    this.remove?.();
    void this.client
      .rpc(releaseRpc, { agentId: this.agentId, leaseId: this.leaseId })
      .catch(() => {});
  }
}
