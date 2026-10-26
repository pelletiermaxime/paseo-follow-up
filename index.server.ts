import type { PluginServerContext } from "@getpaseo/plugin/server";
import { demandRpc, deliveryRpc, followUpSettings, releaseRpc } from "./shared/contracts";
import { generateSuggestion } from "./server/generate";
import { FollowUpService } from "./server/service";
import { trace } from "./server/diagnostics";

// Paseo eagerly copies bundle exports; a hoisted function keeps the default available.
export default function contribute(server: PluginServerContext) {
  const service = new FollowUpService(generateSuggestion);
  const settings = server.registerSettings(followUpSettings);
  let settingsEpoch = 0;
  const readEpoch = settingsEpoch;
  void settings
    .read()
    .then((state) => {
      if (settingsEpoch === readEpoch) {
        if (state.status === "ready") service.configure(state.values);
        else service.setEnabled(false);
      }
    })
    .catch(() => {
      if (settingsEpoch === readEpoch) service.setEnabled(false);
    });
  const cleanup = [
    settings.subscribe((state) => {
      settingsEpoch++;
      if (state.status === "ready") service.configure(state.values);
      else service.setEnabled(false);
    }),
  ];
  cleanup.push(
    server.on("agent.turn_ended", (event, context) => {
      if (
        event.outcome.kind !== "completed" ||
        !event.turnId ||
        !event.agent.workspaceId ||
        event.agent.parentAgentId
      ) {
        trace("turn-ignored", {
          agentId: event.agent.id,
          outcome: event.outcome.kind,
          hasTurnId: !!event.turnId,
          hasWorkspace: !!event.agent.workspaceId,
          subagent: !!event.agent.parentAgentId,
        });
        service.invalidate(event.agent.id);
        return;
      }
      service.completed(event.agent.id, event.turnId, context.paseo, event.agent.workspaceId);
    }),
  );
  for (const event of [
    "agent.turn_started",
    "agent.permission_requested",
    "agent.archived",
    "agent.closed",
  ] as const) {
    cleanup.push(
      server.on(event, (payload) => service.invalidate(payload.agent.id, undefined, event)),
    );
  }
  cleanup.push(
    server.on("workspace.archived", (event) => service.archiveWorkspace(event.workspace.id)),
  );
  server.handle(demandRpc, (input, context) =>
    service.demand(input.agentId, input.leaseId, context.paseo),
  );
  server.handle(releaseRpc, (input) => {
    service.release(input.agentId, input.leaseId);
    return {};
  });
  server.handle(deliveryRpc, (input) => {
    trace("composer-result", input);
    return {};
  });
  return () => {
    settingsEpoch++;
    cleanup.forEach((remove) => remove());
    service.dispose();
  };
}
