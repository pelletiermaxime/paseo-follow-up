import { describe, expect, it, vi } from "vite-plus/test";
import { generateSuggestion, verifyToolFree } from "../server/generate";
import { runCommand } from "../server/command";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mock = vi.hoisted(() => ({
  handler: undefined as unknown as (request: unknown, response: unknown) => Promise<void>,
  body: {} as unknown,
}));
vi.mock("node:http", () => ({
  createServer: (handler: typeof mock.handler) => {
    mock.handler = handler;
    return {
      once: vi.fn(),
      listen: (_port: number, _host: string, ready: () => void) => ready(),
      address: () => ({ port: 1234 }),
      closeAllConnections: vi.fn(),
      close: (done: () => void) => done(),
    };
  },
}));
vi.mock("../server/command", () => ({ runCommand: vi.fn() }));
describe("effective tool exposure gate", () => {
  it.each([
    { body: { model: "gpt-6.1-terra", tools: [] }, passes: true },
    { body: { model: "gpt-6.1-terra" }, passes: true },
    {
      body: { model: "gpt-6.1-terra", tools: [{ type: "function", name: "exec_command" }] },
      passes: false,
    },
    { body: { model: "gpt-6.1-terra", tools: null }, passes: false },
    { body: { model: "another-model", tools: [] }, passes: false },
    { body: { model: "gpt-6-luna", tools: [] }, passes: false },
  ])("fails closed unless the exact model exposes no tools: %j", async ({ body, passes }) => {
    mock.body = body;
    vi.mocked(runCommand).mockImplementation(async () => {
      await mock.handler(
        {
          url: "/responses",
          headers: {},
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify(mock.body));
          },
        },
        { writeHead: vi.fn(), end: vi.fn() },
      );
      throw new Error("Expected local probe refusal");
    });
    const result = verifyToolFree([], "/tmp", new AbortController().signal);
    if (passes) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("Tool-free suggestion invocation unavailable");
  });
  it("rejects a CLI that never produces a verifiable request", async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error("Raw CLI failure"));
    await expect(verifyToolFree([], "/tmp", new AbortController().signal)).rejects.toThrow(
      "Tool-free suggestion invocation unavailable",
    );
  });
});

describe("Configured model availability", () => {
  it("uses the selected model for the frozen catalogue, probe and generation", async () => {
    const catalogue = await mkdtemp(join(tmpdir(), "follow-up-test-catalogue-"));
    vi.stubEnv("CODEX_HOME", catalogue);
    vi.mocked(runCommand).mockClear();
    const selected = { slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "medium" }] };
    let frozenCatalogue: unknown;
    try {
      await writeFile(
        join(catalogue, "models_cache.json"),
        JSON.stringify({
          models: [
            { slug: "gpt-6.1-terra", supported_reasoning_levels: [{ effort: "low" }] },
            selected,
          ],
        }),
      );
      vi.mocked(runCommand).mockImplementation(async (args, directory) => {
        frozenCatalogue = JSON.parse(await readFile(join(directory, "models.json"), "utf8"));
        if (args.includes('model_provider="follow_up_probe"')) {
          await mock.handler(
            {
              url: "/responses",
              headers: {},
              async *[Symbol.asyncIterator]() {
                yield Buffer.from(JSON.stringify({ model: "gpt-6-luna", tools: [] }));
              },
            },
            { writeHead: vi.fn(), end: vi.fn() },
          );
        } else {
          await writeFile(
            args[args.indexOf("--output-last-message") + 1],
            JSON.stringify({ text: "Show an example." }),
          );
        }
      });
      expect(
        await generateSuggestion(
          [
            { role: "user", text: "Explain binary search with an example." },
            { role: "assistant", text: "Binary search halves a sorted search range." },
          ],
          new AbortController().signal,
          { model: "gpt-6-luna", reasoningEffort: "medium" },
        ),
      ).toBe("Show an example.");
      expect(frozenCatalogue).toEqual({ models: [selected] });
      expect(runCommand).toHaveBeenCalledTimes(2);
      for (const [args] of vi.mocked(runCommand).mock.calls) {
        expect(args[args.indexOf("--model") + 1]).toBe("gpt-6-luna");
        expect(args).toContain('model_reasoning_effort="medium"');
        expect(args).not.toContain('model_reasoning_effort="low"');
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(catalogue, { recursive: true, force: true });
    }
  });

  it("does not downgrade an unsupported thinking level", async () => {
    const catalogue = await mkdtemp(join(tmpdir(), "follow-up-test-catalogue-"));
    vi.stubEnv("CODEX_HOME", catalogue);
    vi.mocked(runCommand).mockClear();
    try {
      await writeFile(
        join(catalogue, "models_cache.json"),
        JSON.stringify({
          models: [{ slug: "gpt-6.1-terra", supported_reasoning_levels: [{ effort: "low" }] }],
        }),
      );
      await expect(
        generateSuggestion(
          [
            { role: "user", text: "Explain binary search with an example." },
            { role: "assistant", text: "Binary search halves a sorted search range." },
          ],
          new AbortController().signal,
          { model: "gpt-6.1-terra", reasoningEffort: "high" },
        ),
      ).rejects.toThrow("Suggestion generation unavailable.");
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      await rm(catalogue, { recursive: true, force: true });
    }
  });
  it("does not fall back to another model when the configured model is absent from the host catalogue", async () => {
    const catalogue = await mkdtemp(join(tmpdir(), "follow-up-test-catalogue-"));
    vi.stubEnv("CODEX_HOME", catalogue);
    vi.mocked(runCommand).mockClear();
    try {
      await writeFile(
        join(catalogue, "models_cache.json"),
        JSON.stringify({ models: [{ slug: "gpt-6-luna" }] }),
      );
      await expect(
        generateSuggestion(
          [
            { role: "user", text: "Explain binary search with an example." },
            { role: "assistant", text: "Binary search halves a sorted search range." },
          ],
          new AbortController().signal,
        ),
      ).rejects.toThrow("Suggestion generation unavailable.");
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      await rm(catalogue, { recursive: true, force: true });
    }
  });
});

describe("generation with uncertain language", () => {
  it.each([
    "remove the notes about the settings at the end",
    "Please help me verify keyboard acceptance.",
  ])("calls the small model and keeps short valid output for %s", async (request) => {
    const catalogue = await mkdtemp(join(tmpdir(), "follow-up-test-catalogue-"));
    vi.stubEnv("CODEX_HOME", catalogue);
    vi.mocked(runCommand).mockClear();
    try {
      await writeFile(
        join(catalogue, "models_cache.json"),
        JSON.stringify({
          models: [{ slug: "gpt-6.1-terra", supported_reasoning_levels: [{ effort: "low" }] }],
        }),
      );
      vi.mocked(runCommand).mockImplementation(async (args) => {
        if (args.includes('model_provider="follow_up_probe"')) {
          await mock.handler(
            {
              url: "/responses",
              headers: {},
              async *[Symbol.asyncIterator]() {
                yield Buffer.from(JSON.stringify({ model: "gpt-6.1-terra", tools: [] }));
              },
            },
            { writeHead: vi.fn(), end: vi.fn() },
          );
          throw new Error("Expected local probe refusal");
        }
        await writeFile(
          args[args.indexOf("--output-last-message") + 1],
          JSON.stringify({ text: "Show an example." }),
        );
      });
      expect(
        await generateSuggestion(
          [
            { role: "user", text: request },
            { role: "assistant", text: "The prompt has been updated." },
          ],
          new AbortController().signal,
        ),
      ).toBe("Show an example.");
      expect(runCommand).toHaveBeenCalledTimes(2);
      const generationDirectory = vi.mocked(runCommand).mock.calls[0][1];
      await expect(stat(generationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
      await rm(catalogue, { recursive: true, force: true });
    }
  });
});

describe("model result validation", () => {
  it.each([
    { text: "First line\nSecond line" },
    { text: "First line\u2028Second line" },
    { text: "First line\u2029Second line" },
    { text: "Hidden\u0085control" },
    { text: "x".repeat(241) },
    { text: "Show an example.", extra: "Unexpected field" },
  ])("rejects malformed suggestions and cleans up temporary data: %j", async (output) => {
    const catalogue = await mkdtemp(join(tmpdir(), "follow-up-test-catalogue-"));
    vi.stubEnv("CODEX_HOME", catalogue);
    vi.mocked(runCommand).mockClear();
    try {
      await writeFile(
        join(catalogue, "models_cache.json"),
        JSON.stringify({
          models: [{ slug: "gpt-6.1-terra", supported_reasoning_levels: [{ effort: "low" }] }],
        }),
      );
      vi.mocked(runCommand).mockImplementation(async (args) => {
        if (args.includes('model_provider="follow_up_probe"')) {
          await mock.handler(
            {
              url: "/responses",
              headers: {},
              async *[Symbol.asyncIterator]() {
                yield Buffer.from(JSON.stringify({ model: "gpt-6.1-terra", tools: [] }));
              },
            },
            { writeHead: vi.fn(), end: vi.fn() },
          );
          return;
        }
        await writeFile(args[args.indexOf("--output-last-message") + 1], JSON.stringify(output));
      });
      await expect(
        generateSuggestion(
          [
            { role: "user", text: "Please explain this feature." },
            { role: "assistant", text: "The feature provides an editable draft." },
          ],
          new AbortController().signal,
        ),
      ).rejects.toThrow("Suggestion generation unavailable.");
      expect(runCommand).toHaveBeenCalledTimes(2);
      await expect(stat(vi.mocked(runCommand).mock.calls[0][1])).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(catalogue, { recursive: true, force: true });
    }
  });
});
