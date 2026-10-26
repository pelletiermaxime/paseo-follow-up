import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Message } from "../server/context";
import { FollowUpService } from "../server/service";
import { DEFAULT_GENERATION_SETTINGS } from "../shared/contracts";
import { agent, api, deferred, entry, flush } from "./helpers";
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
  it("cancels old selections without regenerating their turn and uses new settings for new replies", async () => {
    const pending = deferred<string>();
    const generate = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue("New selection");
    const { service, paseo, refetch } = setup(generate);
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    const signal = generate.mock.calls[0][1] as AbortSignal;
    expect(generate.mock.calls[0][2]).toEqual(DEFAULT_GENERATION_SETTINGS);
    service.configure({ enabled: true, model: "gpt-6-luna", reasoningEffort: "medium" });
    expect(signal.aborted).toBe(true);
    pending.resolve("Obsolete result");
    await flush();
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await service.demand("agent-1", "window", paseo)).status).toBe("none");
    refetch.mockResolvedValue({
      entries: [
        entry("user_message", "Explain this change", 1, "turn-2"),
        entry("assistant_message", "The change makes requests cancelable.", 2, "turn-2"),
      ],
    });
    service.completed("agent-1", "turn-2", paseo);
    await flush();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][2]).toEqual({ model: "gpt-6-luna", reasoningEffort: "medium" });
  });

  it("keeps pending generation when only an unchanged settings snapshot arrives", async () => {
    const pending = deferred<string>();
    const generate = vi.fn().mockReturnValue(pending.promise);
    const { service, paseo } = setup(generate);
    await service.demand("agent-1", "window", paseo);
    service.completed("agent-1", "turn-1", paseo);
    await flush();
    service.configure({ enabled: true, ...DEFAULT_GENERATION_SETTINGS });
    expect((generate.mock.calls[0][1] as AbortSignal).aborted).toBe(false);
    pending.resolve("Still current");
    await flush();
    expect((await service.demand("agent-1", "window", paseo)).status).toBe("ready");
  });
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
