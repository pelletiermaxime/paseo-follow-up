import type { PluginClientContext } from "@getpaseo/plugin/client";

export type ComposerResult =
  | { status: "suggested"; remove(): void }
  | { status: "draft-not-empty" | "composer-unavailable" | "submission-in-progress" };
export type Composer = {
  suggestText(input: { serverId: string; agentId: string; text: string }): Promise<ComposerResult>;
};
export function getComposer(client: PluginClientContext): Composer | undefined {
  const candidate = (client as PluginClientContext & { composer?: Composer }).composer;
  return typeof candidate?.suggestText === "function" ? candidate : undefined;
}
