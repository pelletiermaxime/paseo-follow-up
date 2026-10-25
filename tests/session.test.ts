import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PaseoAgentUpdate } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ComposerSession } from "../client/session";
import { getComposer, type ComposerResult } from "../client/composer";
import { demandRpc, releaseRpc, type Suggestion } from "../shared/contracts";
import { agent, deferred, flush } from "./helpers";
const sessions: ComposerSession[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  vi.useRealTimers();
});
function setup(
  response: Suggestion = {
    status: "ready",
    text: "Show an example?",
    turnId: "turn-1",
    lastUserMessageAt: agent().lastUserMessageAt,
  },
  seen = new Set<string>(),
) {
  let update!: (event: PaseoAgentUpdate) => void;
  const rpc = vi.fn(async (contract) => (contract === releaseRpc ? {} : response));
  const unsubscribe = vi.fn();
  const refresh = vi.fn(async () => ({ agent: agent() }));
  const client = {
    rpc,
    paseo: {
      agents: {
        ref: () => ({
          refresh,
          subscribe: (fn: typeof update) => {
            update = fn;
            return unsubscribe;
          },
        }),
      },
    },
  } as unknown as PluginClientContext;
  const remove = vi.fn();
  const suggestText = vi.fn<
    (
      ...args: Parameters<NonNullable<ReturnType<typeof getComposer>>["suggestText"]>
    ) => Promise<ComposerResult>
  >(async () => ({ status: "suggested", remove }));
  const session = new ComposerSession(
    client,
    { suggestText },
    "exact-host",
    "agent-1",
    "lease-1",
    seen,
  );
  sessions.push(session);
  return {
    session,
    client,
    rpc,
    refresh,
    suggestText,
    remove,
    unsubscribe,
    update: (event: PaseoAgentUpdate) => update(event),
  };
}
describe("composer safety", () => {
  it("feature-detects the optional fork API", () => {
    expect(getComposer({} as PluginClientContext)).toBeUndefined();
    expect(getComposer({ composer: {} } as unknown as PluginClientContext)).toBeUndefined();
  });
  it("targets the exact host and agent, with no message submission", async () => {
    const { suggestText, rpc, remove } = setup();
    await flush();
    expect(suggestText).toHaveBeenCalledExactlyOnceWith({
      serverId: "exact-host",
      agentId: "agent-1",
      text: "Show an example?",
    });
    expect(rpc).toHaveBeenCalledWith(demandRpc, { agentId: "agent-1", leaseId: "lease-1" });
    expect(remove).not.toHaveBeenCalled();
  });
  it("does not replay after a non-empty draft refusal", async () => {
    vi.useFakeTimers();
    const { suggestText } = setup();
    suggestText.mockResolvedValue({ status: "draft-not-empty" });
    await flush();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(suggestText).toHaveBeenCalledTimes(1);
  });
  it.each(["composer-unavailable", "submission-in-progress"] as const)(
    "retries cached text after temporary %s and stops after display",
    async (status) => {
      vi.useFakeTimers();
      const { suggestText, remove } = setup();
      suggestText
        .mockResolvedValueOnce({ status })
        .mockResolvedValue({ status: "suggested", remove });
      await flush();
      expect(suggestText).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(suggestText).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(suggestText).toHaveBeenCalledTimes(2);
    },
  );
  it("does not consume a turn when refreshing the source temporarily fails", async () => {
    vi.useFakeTimers();
    const { refresh, suggestText } = setup();
    refresh.mockRejectedValueOnce(new Error("Temporary connection failure"));
    await flush();
    expect(suggestText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(suggestText).toHaveBeenCalledTimes(1);
  });
  it("displays the next cached turn even when no pending poll cleared the previous source", async () => {
    vi.useFakeTimers();
    const { rpc, refresh, update, suggestText } = setup();
    await flush();
    rpc.mockResolvedValue({
      status: "ready",
      text: "Another example?",
      turnId: "turn-2",
      lastUserMessageAt: "new-message",
    });
    refresh.mockImplementation(async () => {
      const next = agent({ lastUserMessageAt: "new-message" });
      update({ kind: "upsert", agent: next });
      return { agent: next };
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(suggestText).toHaveBeenCalledTimes(2);
  });
  it("does not replay a dismissed or accepted suggestion on remount", async () => {
    const seen = new Set<string>();
    const first = setup(undefined, seen);
    await flush();
    first.session.dispose();
    const second = setup(undefined, seen);
    await flush();
    expect(second.suggestText).not.toHaveBeenCalled();
  });
  it("removes a result resolving after navigation and releases demand", async () => {
    const pending = deferred<ComposerResult>();
    const { session, suggestText, rpc, unsubscribe } = setup();
    suggestText.mockReturnValue(pending.promise);
    await flush();
    session.dispose();
    const remove = vi.fn();
    pending.resolve({ status: "suggested", remove });
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(releaseRpc, { agentId: "agent-1", leaseId: "lease-1" });
  });
  it("removes displayed text when a new turn starts", async () => {
    const { update, remove } = setup();
    await flush();
    update({
      kind: "upsert",
      agent: agent({ status: "running", activeTurn: { turnId: "next", startedAt: null } }),
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("rejects stale source context before displaying", async () => {
    const { refresh, suggestText } = setup();
    refresh.mockResolvedValue({ agent: agent({ lastUserMessageAt: "newer" }) });
    await flush();
    expect(suggestText).not.toHaveBeenCalled();
  });
});
