import { describe, expect, it } from "vite-plus/test";
import { disabledFeatures, generateSuggestion, generationArgs } from "../server/generate";
import { DEFAULT_MODEL } from "../shared/contracts";
import { hasLanguageMismatch } from "../server/language";
import type { Message } from "../server/context";

describe("Suggestion invocation contract", () => {
  it("uses only the configured small model, stdin and isolated saved-auth CLI flags", () => {
    const args = generationArgs("/tmp/follow-up-test");
    expect(DEFAULT_MODEL).toBe("gpt-6.1-terra");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6.1-terra");
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args).toContain(DEFAULT_MODEL);
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("tools.update_plan.enabled=false");
    expect(args).toContain('web_search="disabled"');
    expect(disabledFeatures).toEqual(
      expect.arrayContaining([
        "shell_tool",
        "multi_agent",
        "apps",
        "plugins",
        "code_mode_host",
        "browser_use",
        "computer_use",
      ]),
    );
    expect(args.join(" ")).not.toMatch(/api.key|auth.json|dangerously/);
  });
  it("passes the selected model and thinking level without adding default overrides", () => {
    const args = generationArgs("/tmp/follow-up-test", {
      model: "gpt-6-luna",
      reasoningEffort: "high",
    });
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6-luna");
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).not.toContain('model_reasoning_effort="low"');
    expect(args).not.toContain(DEFAULT_MODEL);
  });
  it.skipIf(process.env.FOLLOW_UP_LIVE !== "1")(
    "returns English or no suggestion for a real English request with French context",
    async () => {
      const text = await generateSuggestion(
        [
          {
            role: "user",
            text: 'Please help me verify keyboard acceptance. A previous suggestion said "Peux-tu me guider pour faire le dernier test manuel ?".',
          },
          {
            role: "assistant",
            text: "Le test manuel consiste à accepter la suggestion au clavier puis modifier le brouillon sans envoyer le message.",
          },
        ],
        new AbortController().signal,
      );
      expect(text?.length ?? 0).toBeLessThanOrEqual(240);
      expect(
        text === null || !hasLanguageMismatch("Please help me verify keyboard acceptance.", text),
      ).toBe(true);
      console.info(
        JSON.stringify({
          model: DEFAULT_MODEL,
          toolFreeProbe: "passed",
          suggestionCharacters: text?.length ?? 0,
        }),
      );
    },
    75_000,
  );
  it.skipIf(process.env.FOLLOW_UP_LIVE !== "1")(
    "accepts a valid real result for a request with weak language scores",
    async () => {
      const text = await generateSuggestion(
        [
          { role: "user", text: "remove the notes about the settings at the end" },
          {
            role: "assistant",
            text: "The extra notes have been removed from the settings documentation. The rest of the documentation is unchanged.",
          },
        ],
        new AbortController().signal,
      );
      // The model is allowed to decide that a completed edit needs no follow-up. The mocked
      // generation test separately proves weak language scores do not skip the model call.
      expect(text?.length ?? 0).toBeLessThanOrEqual(240);
      if (text !== null) {
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      }
      console.info(
        JSON.stringify({
          model: DEFAULT_MODEL,
          toolFreeProbe: "passed",
          suggestionCharacters: text?.length ?? 0,
        }),
      );
    },
    75_000,
  );
});

describe("follow-up usefulness", () => {
  it.skipIf(process.env.FOLLOW_UP_LIVE !== "1").each([
    {
      name: "repository publication with URL, commit and remote verification already provided",
      messages: [
        { role: "user", text: "Create the public repository, commit and push it." },
        {
          role: "assistant",
          text: "Created and pushed the public repository: https://github.com/example/demo-plugin. Branch: main, tracking origin/main. Commit: abc1234. GitHub's main matches the local commit, and the working tree is clean.",
        },
      ] satisfies Message[],
    },
    {
      name: "a request for a URL and commit hash that the answer already supplies",
      messages: [
        { role: "user", text: "What is the repository URL and the latest commit hash?" },
        {
          role: "assistant",
          text: "Repository URL: https://github.com/example/demo-plugin. Latest commit: abc1234.",
        },
      ] satisfies Message[],
    },
  ])(
    "returns no suggestion after $name",
    async ({ messages }) => {
      expect(await generateSuggestion(messages, new AbortController().signal)).toBeNull();
    },
    75_000,
  );

  it.skipIf(process.env.FOLLOW_UP_LIVE !== "1")(
    "still suggests a useful follow-up when the user's requested example is missing",
    async () => {
      const text = await generateSuggestion(
        [
          { role: "user", text: "Explain binary search, including a worked example on an array." },
          {
            role: "assistant",
            text: "Binary search repeatedly halves a sorted search range. Compare the target with the middle element, then search the left or right half. Its time complexity is O(log n).",
          },
        ],
        new AbortController().signal,
      );
      expect(text).not.toBeNull();
      expect(text).toMatch(/example|walk|step|array/i);
    },
    75_000,
  );
});
