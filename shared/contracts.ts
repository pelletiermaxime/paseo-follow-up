import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_MODEL = "gpt-6.1-terra";
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const generationSettingsSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
    .default(DEFAULT_MODEL),
  reasoningEffort: z.enum(REASONING_EFFORTS).default("low"),
});
export type GenerationSettings = z.output<typeof generationSettingsSchema>;
export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = generationSettingsSchema.parse({});
export const followUpSettingsSchema = generationSettingsSchema
  .extend({ enabled: z.boolean().default(true) })
  .default({ enabled: true, ...DEFAULT_GENERATION_SETTINGS });
export type FollowUpValues = z.output<typeof followUpSettingsSchema>;
export const SETTINGS_SCREEN = "follow-up";
export const POLL_MS = 3_000;
export const LEASE_MS = 12_000;
export const followUpSettings = defineSettings({
  id: "suggestions",
  scope: "host",
  version: 2,
  schema: followUpSettingsSchema,
  migrate: (values) => followUpSettingsSchema.parse(values),
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
