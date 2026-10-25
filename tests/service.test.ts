import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Message } from "../server/context";
import { FollowUpService } from "../server/service";
import { agent, api, deferred, flush } from "./helpers";
const services: FollowUpService[] = [];
afterEach(() => {
  services.splice(0).forEach((s) => s.dispose());
  vi.useRealTimers();
});
function setup(
  generate: ReturnType<
    typeof vi.fn<(messages: Message[], signal: AbortSignal) => Promise<string | null>>
  > = vi.fn(async () => "Show me an example."),
) {
  const service = new FollowUpService(generate);
  services.push(service);
  service.setEnabled(true);
  return { service, generate, ...api() };
}
describe("daemon demand and completion coordination", () => {
  it("waits for the completed foreground turn to become idle before generating", async () => {
    const { service, generate, paseo, refresh } = setup();
    refresh.mockResolvedValue({
      agent: agent({ status: "running", activeTurn: { turnId: "turn-1", startedAt: null } }),
    });
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    expect(generate).not.toHaveBeenCalled();
    refresh.mockResolvedValue({ agent: agent() });
    await service.demand("agent-1", "window", paseo);
    await flush();
    expect(generate).toHaveBeenCalledOnce();
  });
  it("cancels work when its workspace is archived", async () => {
    const pending = deferred<string>();
    let signal: AbortSignal | undefined;
    const { service, paseo } = setup(
      vi.fn((_messages: Message[], value: AbortSignal) => {
        signal = value;
        return pending.promise;
      }),
    );
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo, "workspace-1");
    await flush();
    service.archiveWorkspace("workspace-1");
    expect(signal?.aborted).toBe(true);
    pending.resolve("obsolete");
    await flush();
    expect((await service.demand("agent-1", "window", paseo)).status).toBe("none");
  });
  it("does not backfill or generate for unopened chats", async () => {
    const { service, generate, paseo, refetch } = setup();
    await service.demand("agent-1", "window", paseo);
    expect(refetch).not.toHaveBeenCalled();
    service.completed("unopened", "turn-1", paseo);
    await flush();
    expect(generate).not.toHaveBeenCalled();
  });
  it("deduplicates across clients and repeated completion hooks", async () => {
    const { service, generate, paseo } = setup();
    await service.demand("agent-1", "window-a", paseo);
    await service.demand("agent-1", "window-b", paseo);
    service.completed("agent-1", "turn-1", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await service.demand("agent-1", "window-b", paseo)).toMatchObject({
      status: "ready",
      turnId: "turn-1",
    });
    service.release("agent-1", "window-a");
    expect((await service.demand("agent-1", "window-b", paseo)).status).toBe("ready");
    service.release("agent-1", "window-b");
    expect((await service.demand("agent-1", "window-c", paseo)).status).toBe("none");
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("aborts obsolete work and ignores generators which complete despite cancellation", async () => {
    const pending = deferred<string>();
    let signal: AbortSignal | undefined;
    const { service, paseo } = setup(
      vi.fn((_messages: Message[], value: AbortSignal) => {
        signal = value;
        return pending.promise;
      }),
    );
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    service.invalidate("agent-1");
    expect(signal?.aborted).toBe(true);
    pending.resolve("Stale result");
    await flush();
    expect((await service.demand("agent-1", "window", paseo)).status).toBe("none");
  });
  it("checks last user message again before delivery", async () => {
    const { service, paseo, refresh } = setup();
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    refresh.mockResolvedValue({ agent: agent({ lastUserMessageAt: "newer" }) });
    expect((await service.demand("agent-1", "window", paseo)).status).toBe("none");
  });
  it("does not generate when a permission is pending", async () => {
    const { service, paseo, refresh, generate } = setup();
    refresh.mockResolvedValue({ agent: agent({ status: "running" }) });
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    expect(generate).not.toHaveBeenCalled();
  });
  it("reports sanitized unavailability once, without retrying the turn", async () => {
    const { service, paseo, generate } = setup(
      vi.fn(async () => {
        throw new Error("SECRET provider transcript");
      }),
    );
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    expect(await service.demand("agent-1", "window", paseo)).toEqual({
      status: "unavailable",
      turnId: null,
      text: null,
      lastUserMessageAt: null,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("cancels on disable and lease expiration", async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    let signal: AbortSignal | undefined;
    const { service, paseo } = setup(
      vi.fn((_messages: Message[], value: AbortSignal) => {
        signal = value;
        return pending.promise;
      }),
    );
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal?.aborted).toBe(true);
    service.setEnabled(false);
    expect((await service.demand("agent-1", "window", paseo)).status).toBe("disabled");
    pending.resolve("Late");
    await flush();
  });
  it("bounds generation concurrency", async () => {
    const first = deferred<string>();
    const generate = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("Next?");
    const { service, paseo } = setup(generate);
    await service.demand("a", "window-a", paseo);
    await service.demand("b", "window-b", paseo);
    service.completed("a", "turn-1", paseo);
    service.completed("b", "turn-1", paseo);
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    first.resolve("First?");
    await flush();
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
