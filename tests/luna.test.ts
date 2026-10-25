import { describe, expect, it } from "vite-plus/test";
import { disabledFeatures, generateLuna, generationArgs } from "../server/luna";
import { MODEL } from "../shared/contracts";
import { hasLanguageMismatch } from "../server/language";

describe("Luna invocation contract", () => {
  it("uses only Luna, stdin and isolated saved-auth CLI flags", () => {
    const args = generationArgs("/tmp/follow-up-test");
    expect(args).toContain(MODEL);
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
  it.skipIf(process.env.FOLLOW_UP_LIVE !== "1")(
    "returns English or no suggestion for a real English request with French context",
    async () => {
      const text = await generateLuna(
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
          model: MODEL,
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
      const text = await generateLuna(
        [
          { role: "user", text: "remove the notes about the settings at the end" },
          {
            role: "assistant",
            text: "The extra notes have been removed from the settings documentation. The rest of the documentation is unchanged.",
          },
        ],
        new AbortController().signal,
      );
      // Luna is allowed to decide that a completed edit needs no follow-up. The mocked
      // generation test separately proves weak language scores do not skip the model call.
      expect(text?.length ?? 0).toBeLessThanOrEqual(240);
      if (text !== null) {
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      }
      console.info(
        JSON.stringify({
          model: MODEL,
          toolFreeProbe: "passed",
          suggestionCharacters: text?.length ?? 0,
        }),
      );
    },
    75_000,
  );
});
