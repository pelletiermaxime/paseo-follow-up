import { describe, expect, it } from "vite-plus/test";
import { eligible, extractContext, generationPrompt } from "../server/context";
import { agent, entry } from "./helpers";

describe("bounded conversation context", () => {
  it("includes only ordered user and assistant text and excludes tools, reasoning and plugin content", () => {
    const messages = extractContext(
      [
        entry("assistant_message", "Answer", 5),
        { ...entry("plugin", "newest plugin entry", 6), turnId: undefined },
        entry("reasoning", "private thought", 2),
        entry("tool_call", "dangerous command", 3),
        entry("plugin", "internal data", 4),
        Object.assign(entry("user_message", "Question", 1), {
          item: { type: "user_message", text: "Question", attachments: ["secret"] },
        }),
      ],
      "turn-1",
    );
    expect(messages).toEqual([
      { role: "user", text: "Question" },
      { role: "assistant", text: "Answer" },
    ]);
    expect(generationPrompt(messages)).not.toMatch(/private thought|dangerous command|"secret"/);
  });
  it("caps messages, per-message length and total text", () => {
    const messages = extractContext(
      Array.from({ length: 20 }, (_, i) =>
        entry(i % 2 ? "assistant_message" : "user_message", "x".repeat(9000), i),
      ),
      "turn-1",
    );
    expect(messages.length).toBeLessThanOrEqual(8);
    expect(messages.every((m) => m.text.length <= 3000)).toBe(true);
    expect(messages.reduce((n, m) => n + m.text.length, 0)).toBe(12_000);
  });
  it("preserves the latest user request across long assistant progress messages", () => {
    const messages = extractContext(
      [
        entry("user_message", "Please implement the feature in this repository.", 1),
        ...Array.from({ length: 12 }, (_, i) =>
          entry("assistant_message", "French progress: terminé. ".repeat(300), i + 2),
        ),
      ],
      "turn-1",
    );
    expect(messages[0]).toEqual({
      role: "user",
      text: "Please implement the feature in this repository.",
    });
    expect(messages.length).toBeLessThanOrEqual(8);
    expect(messages.reduce((size, message) => size + message.text.length, 0)).toBeLessThanOrEqual(
      12_000,
    );
  });
  it("does not infer a language from assistant-only context or an empty latest request", () => {
    expect(extractContext([entry("assistant_message", "Voici le résultat.", 2)], "turn-1")).toEqual(
      [],
    );
    expect(
      extractContext(
        [
          entry("user_message", "Old request", 1),
          entry("user_message", "", 2),
          entry("assistant_message", "Answer", 3),
        ],
        "turn-1",
      ),
    ).toEqual([]);
  });
  it("supplies the latest user request separately from the conversation context", () => {
    const prompt = generationPrompt([
      { role: "user", text: "Please help me verify keyboard acceptance." },
      { role: "assistant", text: "Vérifie le compositeur." },
    ]);
    expect(prompt).toContain(
      'Latest user request JSON (quoted data):\n"Please help me verify keyboard acceptance."',
    );
  });
  it("rejects a tail from a newer turn and a trailing user message", () => {
    expect(
      extractContext(
        [entry("assistant_message", "old", 1), entry("user_message", "new", 2, "turn-2")],
        "turn-1",
      ),
    ).toEqual([]);
    expect(
      extractContext(
        [entry("assistant_message", "old", 1), entry("user_message", "new", 2)],
        "turn-1",
      ),
    ).toEqual([]);
  });
  it.each([
    { internal: true },
    { archivedAt: "now" },
    { status: "running" as const },
    { status: "closed" as const },
    { activeTurn: { turnId: "new", startedAt: null } },
    { workspaceId: undefined },
    { pendingPermissions: [{}] as PaseoAgent["pendingPermissions"] },
    { providerUnavailable: true },
  ])("rejects ineligible agent %j", (patch) => expect(eligible(agent(patch))).toBe(false));
});
import type { PaseoAgent } from "@getpaseo/client";
