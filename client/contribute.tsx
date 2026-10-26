import { useEffect, useState } from "react";
import { Text } from "react-native";
import {
  useSettings,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import type { PaseoAgent } from "@getpaseo/client";
import { followUpSettings, SETTINGS_SCREEN } from "../shared/contracts";
import { getComposer } from "./composer";
import { ComposerSession } from "./session";
import { SettingsScreen } from "./settings";
import { observeAgents } from "./observe-agents";

export function contributeClient(client: PluginClientContext): () => void {
  const composer = getComposer(client);
  let disposed = false;
  let serverId: string | undefined;
  let nextLease = 0;
  const clientNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const seen = new Set<string>();
  const registrations = new Map<
    string,
    { workspaceId: string; button: PluginButtonRegistration }
  >();
  const sessions = new Set<ComposerSession>();
  const cleanup: (() => void)[] = [];
  const Screen = (props: PluginSurfaceProps) => (
    <SettingsScreen {...props} supported={!!composer && props.layout.platform === "web"} />
  );
  cleanup.push(
    client.addSettingsScreen({
      id: SETTINGS_SCREEN,
      title: "Follow-up",
      icon: "Sparkles",
      Component: Screen,
    }),
  );
  if (!composer)
    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };

  function DemandIcon(props: PluginButtonIconProps) {
    const settings = useSettings(followUpSettings);
    const [unavailable, setUnavailable] = useState(false);
    const agentId = props.context === "agent" ? props.agentId : undefined;
    const enabled = settings.status === "ready" && settings.values.enabled;
    useEffect(() => {
      if (
        disposed ||
        !enabled ||
        !agentId ||
        !serverId ||
        props.host.id !== serverId ||
        props.layout.platform !== "web" ||
        !composer
      )
        return;
      const session = new ComposerSession(
        client,
        composer,
        serverId,
        agentId,
        `${clientNonce}-${++nextLease}`,
        seen,
        (status) => setUnavailable(status === "unavailable"),
      );
      sessions.add(session);
      return () => {
        session.dispose();
        sessions.delete(session);
      };
    }, [enabled, agentId, props.host.id, props.layout.platform]);
    return (
      <Text
        accessibilityLabel={
          unavailable
            ? "Small model unavailable. Check Codex access in Follow-up settings."
            : "Follow-up settings"
        }
        style={{
          color: unavailable ? props.theme.colors.statusWarning : props.color,
          fontSize: props.size,
        }}
      >
        {unavailable ? "!" : "✦"}
      </Text>
    );
  }
  function upsert(agent: PaseoAgent) {
    if (disposed) return;
    const existing = registrations.get(agent.id);
    if (existing && existing.workspaceId !== agent.workspaceId) {
      existing.button.remove();
      registrations.delete(agent.id);
    }
    if (!agent.workspaceId || agent.internal || agent.archivedAt || agent.status === "closed") {
      remove(agent.id);
      return;
    }
    if (registrations.has(agent.id)) return;
    registrations.set(agent.id, {
      workspaceId: agent.workspaceId,
      button: client.addComposerPill({
        id: `suggestions-${agent.id}`,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Follow-up settings",
          label: "Follow-up",
          icon: DemandIcon,
          behavior: { kind: "action", onPress: () => client.openSettings(SETTINGS_SCREEN) },
        },
      }),
    });
  }
  function remove(agentId: string) {
    registrations.get(agentId)?.button.remove();
    registrations.delete(agentId);
  }
  const stopObserving = observeAgents(client.paseo, {
    host: (id) => {
      serverId = id;
    },
    upsert,
    remove,
    reset: () => {
      sessions.forEach((session) => session.dispose());
      sessions.clear();
      registrations.forEach((entry) => entry.button.remove());
      registrations.clear();
    },
  });
  return () => {
    if (disposed) return;
    disposed = true;
    stopObserving();
    cleanup.reverse().forEach((remove) => remove());
  };
}
