import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const MODEL = "gpt-6-luna";
export const SETTINGS_SCREEN = "follow-up";
export const POLL_MS = 3_000;
export const LEASE_MS = 12_000;
export const followUpSettings = defineSettings({
  id: "suggestions",
  scope: "host",
  version: 1,
  schema: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
});
const identity = z.object({
  agentId: z.string().min(1).max(200),
  leaseId: z.string().min(1).max(200),
});
export const suggestionSchema = z.object({
  status: z.enum(["none", "pending", "ready", "unavailable", "disabled"]),
  turnId: z.string().nullable(),
  text: z.string().max(240).nullable(),
  lastUserMessageAt: z.string().nullable(),
});
export type Suggestion = z.output<typeof suggestionSchema>;
export const demandRpc = defineRpc({
  name: "follow-up.demand",
  input: identity,
  output: suggestionSchema,
});
export const releaseRpc = defineRpc({
  name: "follow-up.release",
  input: identity,
  output: z.object({}),
});
export const deliveryRpc = defineRpc({
  name: "follow-up.delivery",
  input: z.object({
    agentId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    status: z.enum([
      "suggested",
      "draft-not-empty",
      "composer-unavailable",
      "submission-in-progress",
      "stale",
    ]),
  }),
  output: z.object({}),
});
