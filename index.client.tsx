import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeClient } from "./client/contribute";
// Paseo eagerly copies bundle exports; a hoisted function keeps the default available.
export default function contribute(client: PluginClientContext) {
  return contributeClient(client);
}
