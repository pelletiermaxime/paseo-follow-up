import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { expect, it, vi } from "vite-plus/test";
import contribute from "../index.server";
import { generateSuggestion } from "../server/generate";
import { followUpSettings } from "../shared/contracts";
import { api, deferred, flush } from "./helpers";

vi.mock("../server/generate", () => ({ generateSuggestion: vi.fn(async () => null) }));

it("uses live host settings even if an older initial settings read finishes later", async () => {
  type State = PluginSettingsState<typeof followUpSettings.schema>;
  const initial = deferred<State>();
  let listener!: (state: State) => void;
  const hooks = new Map<string, unknown>();
  const handlers = new Map<string, unknown>();
  const server = {
    registerSettings: () => ({
      read: () => initial.promise,
      subscribe: (callback: typeof listener) => {
        listener = callback;
        return vi.fn();
      },
    }),
    on: (name: string, handler: unknown) => {
      hooks.set(name, handler);
      return vi.fn();
    },
    handle: (contract: { name: string }, handler: unknown) => handlers.set(contract.name, handler),
  } as unknown as PluginServerContext;
  vi.mocked(generateSuggestion).mockClear();
  const cleanup = contribute(server);
  try {
    listener({
      status: "ready",
      revision: "newer",
      values: { enabled: true, model: "gpt-6-luna", reasoningEffort: "medium" },
    });
    initial.resolve({
      status: "ready",
      revision: "older",
      values: { enabled: false, model: "gpt-6.1-terra", reasoningEffort: "low" },
    });
    await flush();
    const { paseo } = api();
    const demand = handlers.get("follow-up.demand") as (
      input: { agentId: string; leaseId: string },
      context: { paseo: PaseoApi },
    ) => Promise<unknown>;
    await demand({ agentId: "agent-1", leaseId: "window" }, { paseo });
    const completed = hooks.get("agent.turn_ended") as (
      event: unknown,
      context: { paseo: PaseoApi },
    ) => void;
    completed(
      {
        outcome: { kind: "completed" },
        turnId: "turn-1",
        agent: { id: "agent-1", workspaceId: "workspace-1" },
      },
      { paseo },
    );
    await flush();
    expect(generateSuggestion).toHaveBeenCalledOnce();
    expect(vi.mocked(generateSuggestion).mock.calls[0][2]).toEqual({
      model: "gpt-6-luna",
      reasoningEffort: "medium",
    });
  } finally {
    cleanup();
  }
});
