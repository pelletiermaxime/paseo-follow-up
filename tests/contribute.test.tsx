import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type {
  PluginButtonIconProps,
  PluginClientContext,
  PluginComposerPillContribution,
} from "@getpaseo/plugin/client";
import type { SubscriptionObserver, PaseoAgentListResult } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { contributeClient } from "../client/contribute";
import { agent, deferred, flush } from "./helpers";
vi.mock("react-native", () => ({
  Text: "Text",
  ScrollView: "ScrollView",
  View: "View",
  Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => ({ status: "ready", values: { enabled: true } }),
}));
const cleanups: (() => void)[] = [];
let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => rendered?.unmount());
  rendered = undefined;
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function setup(supported = true) {
  let observer!: SubscriptionObserver<PaseoAgentListResult & { subscriptionId: string }>;
  const snapshot: PaseoAgentListResult & { subscriptionId: string } = {
    subscriptionId: "subscription-1",
    entries: [
      {
        agent: agent(),
        project: {
          projectKey: "fixture-project",
          projectName: "Fixture",
          checkout: {
            cwd: "/tmp",
            isGit: false,
            worktreeRoot: null,
            currentBranch: null,
            remoteUrl: null,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: null,
          },
        },
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    requestId: "request-1",
  };
  const release = vi.fn(async () => {});
  const subscription = {
    ready: Promise.resolve(snapshot),
    release,
    subscribe: vi.fn((fn) => {
      observer = fn;
      fn.snapshot(snapshot);
      return vi.fn();
    }),
  };
  const list = vi.fn(async () => ({ ...snapshot, subscription }));
  const addComposerPill = vi.fn((_entry: PluginComposerPillContribution) => ({
    remove: vi.fn(),
    update: vi.fn(),
  }));
  const rpc = vi.fn(async () => ({
    status: "none",
    turnId: null,
    text: null,
    lastUserMessageAt: null,
  }));
  const addSettingsScreen = vi.fn(() => vi.fn());
  const client = {
    addSettingsScreen,
    addComposerPill,
    rpc,
    ...(supported ? { composer: { suggestText: vi.fn() } } : {}),
    paseo: {
      hosts: { list: vi.fn(async () => ({ self: { serverId: "host-1" } })) },
      agents: { list, ref: () => ({ subscribe: () => vi.fn() }) },
    },
  } as unknown as PluginClientContext;
  const cleanup = contributeClient(client);
  cleanups.push(cleanup);
  return {
    addSettingsScreen,
    client,
    list,
    rpc,
    addComposerPill,
    release,
    snapshot,
    subscription,
    observer: () => observer,
    cleanup,
  };
}
describe("public SDK client contribution", () => {
  it("loads on stock clients and never subscribes or generates", async () => {
    const { list, rpc, addComposerPill, addSettingsScreen } = setup(false);
    await flush();
    expect(addSettingsScreen).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(addComposerPill).not.toHaveBeenCalled();
  });
  it("only requests demand when the composer pill actually mounts, and ignores the wrong host", async () => {
    const { addComposerPill, rpc } = setup();
    await flush();
    expect(addComposerPill).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
    const Icon = addComposerPill.mock.calls[0][0].button
      .icon as React.ComponentType<PluginButtonIconProps>;
    const props = {
      context: "agent",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      host: { id: "wrong-host", label: "Wrong" },
      layout: { platform: "web", compact: false },
      color: "black",
      size: 16,
    } as PluginButtonIconProps;
    await act(async () => {
      rendered = create(<Icon {...props} />);
    });
    expect(rpc).not.toHaveBeenCalled();
    await act(async () =>
      rendered!.update(<Icon {...props} host={{ id: "host-1", label: "Host" }} />),
    );
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("does not generate on mobile clients without touch acceptance", async () => {
    const { addComposerPill, rpc } = setup();
    await flush();
    const Icon = addComposerPill.mock.calls[0][0].button
      .icon as React.ComponentType<PluginButtonIconProps>;
    const props = {
      context: "agent",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      host: { id: "host-1", label: "Host" },
      layout: { platform: "ios", compact: true },
      color: "black",
      size: 16,
    } as PluginButtonIconProps;
    await act(async () => {
      rendered = create(<Icon {...props} />);
    });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("reconnect snapshots register UI without generating and released subscriptions survive late setup", async () => {
    const { observer, snapshot, rpc, cleanup, release } = setup();
    await flush();
    observer().snapshot(snapshot);
    expect(rpc).not.toHaveBeenCalled();
    cleanup();
    expect(release).toHaveBeenCalledOnce();
  });
  it("releases a subscription that arrives after unload", async () => {
    const { list, subscription, snapshot, cleanup, release } = setup();
    const pending = deferred<Awaited<ReturnType<typeof list>>>();
    list.mockReturnValue(pending.promise);
    await flush();
    cleanup();
    pending.resolve({ ...snapshot, subscription });
    await flush();
    expect(release).toHaveBeenCalledOnce();
  });
  it("recovers after a permanent subscription error without reloading the plugin", async () => {
    vi.useFakeTimers();
    const { observer, snapshot, addComposerPill, list, release, rpc } = setup();
    await flush();
    const oldObserver = observer();
    const first = addComposerPill.mock.results[0].value;
    oldObserver.error!(new Error("Subscription restore failed"));
    expect(first.remove).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(addComposerPill).toHaveBeenCalledTimes(2);
    expect(rpc).not.toHaveBeenCalled();
    oldObserver.snapshot({
      ...snapshot,
      entries: [{ ...snapshot.entries[0], agent: agent({ id: "stale-agent" }) }],
    });
    expect(addComposerPill).toHaveBeenCalledTimes(2);
  });
  it("removes registrations absent from a reconnect snapshot", async () => {
    const { observer, snapshot, addComposerPill } = setup();
    await flush();
    observer().snapshot({ ...snapshot, entries: [] });
    expect(addComposerPill.mock.results[0].value.remove).toHaveBeenCalledOnce();
  });
  it("does not resurrect entries removed by buffered updates after the bootstrap snapshot", async () => {
    const { subscription, snapshot, addComposerPill } = setup();
    subscription.subscribe.mockImplementationOnce((fn) => {
      fn.snapshot(snapshot);
      fn.update({ type: "agent_update", payload: { kind: "remove", agentId: "agent-1" } });
      return vi.fn();
    });
    await flush();
    expect(addComposerPill).toHaveBeenCalledOnce();
    expect(addComposerPill.mock.results[0].value.remove).toHaveBeenCalledOnce();
  });
  it("keeps entries shared by multiple pages until every page removes them", async () => {
    const { list, snapshot, addComposerPill } = setup();
    const observers: SubscriptionObserver<typeof snapshot>[] = [];
    const page = (hasMore: boolean) => ({
      ...snapshot,
      pageInfo: { ...snapshot.pageInfo, hasMore, nextCursor: hasMore ? "page-2" : null },
      subscription: {
        ready: Promise.resolve(snapshot),
        release: vi.fn(async () => {}),
        subscribe: vi.fn((value: SubscriptionObserver<typeof snapshot>) => {
          observers.push(value);
          value.snapshot(snapshot);
          return vi.fn();
        }),
      },
    });
    list.mockResolvedValueOnce(page(true)).mockResolvedValueOnce(page(false));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(addComposerPill).toHaveBeenCalledOnce();
    observers[0].snapshot({ ...snapshot, entries: [] });
    expect(addComposerPill.mock.results[0].value.remove).not.toHaveBeenCalled();
    observers[1].snapshot({ ...snapshot, entries: [] });
    expect(addComposerPill.mock.results[0].value.remove).toHaveBeenCalledOnce();
  });
  it("cancels pending subscription recovery on unload", async () => {
    vi.useFakeTimers();
    const { observer, list, cleanup } = setup();
    await flush();
    observer().error!(new Error("Subscription restore failed"));
    cleanup();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(list).toHaveBeenCalledOnce();
  });
});
