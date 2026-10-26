import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  DEFAULT_GENERATION_SETTINGS,
  DEFAULT_MODEL,
  generationSettingsSchema,
  type GenerationSettings,
} from "../shared/contracts";
import { generationPrompt, type Message } from "./context";
import { runCommand } from "./command";
import { detectLanguage, hasLanguageMismatch } from "./language";
import { trace } from "./diagnostics";

export const disabledFeatures = [
  "shell_tool",
  "multi_agent",
  "multi_agent_v2",
  "apps",
  "plugins",
  "remote_plugin",
  "memories",
  "browser_use",
  "computer_use",
  "image_generation",
  "view_image",
  "code_mode",
  "code_mode_host",
  "goals",
  "sleep_tool",
  "in_app_browser",
  "in_app_chat",
  "in_app_voice",
  "in_app_dictation",
  "in_app_local_automation",
  "skill_search",
  "tool_suggest",
  "hooks",
  "runtime_agent_instances",
];
export function generationArgs(
  directory: string,
  selection: GenerationSettings = DEFAULT_GENERATION_SETTINGS,
): string[] {
  const settings = generationSettingsSchema.parse(selection);
  const config = [
    'web_search="disabled"',
    "tools.update_plan.enabled=false",
    "tools.experimental_request_user_input.enabled=false",
    "agents.enabled=false",
    "project_doc_max_bytes=0",
    'history.persistence="none"',
    `model_reasoning_effort=${JSON.stringify(settings.reasoningEffort)}`,
    "analytics.enabled=false",
    "feedback.enabled=false",
    `log_dir=${JSON.stringify(directory)}`,
    `sqlite_home=${JSON.stringify(directory)}`,
    `model_catalog_json=${JSON.stringify(join(directory, "models.json"))}`,
  ];
  return [
    "-a",
    "never",
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    settings.model,
    ...disabledFeatures.flatMap((f) => ["--disable", f]),
    ...config.flatMap((c) => ["-c", c]),
  ];
}

// Probe the *effective* request, not just CLI flags. Fail closed after CLI/model changes that expose
// any tool. This local provider has no auth and receives only a constant probe, never conversation data.
export async function verifyToolFree(
  args: string[],
  directory: string,
  signal: AbortSignal,
  expectedModel: string = DEFAULT_MODEL,
): Promise<void> {
  let verified = false;
  let unsafe = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128_000) throw new Error("Probe too large");
        chunks.push(chunk);
      }
      if (request.url?.includes("responses")) {
        const raw = Buffer.concat(chunks);
        const body = JSON.parse(
          (request.headers["content-encoding"] === "gzip"
            ? gunzipSync(raw, { maxOutputLength: 256_000 })
            : raw
          ).toString(),
        );
        if (
          body.model !== expectedModel ||
          (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0))
        )
          unsafe = true;
        else verified = true;
      }
    } catch {
      unsafe = true;
    }
    response.writeHead(400);
    response.end("{}");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Probe unavailable");
    await runCommand(
      [
        ...args,
        "-c",
        'model_provider="follow_up_probe"',
        "-c",
        `model_providers.follow_up_probe={name="probe",base_url="http://127.0.0.1:${address.port}",wire_api="responses",request_max_retries=0,stream_max_retries=0}`,
        "-",
      ],
      directory,
      "Return an empty text string as JSON.",
      signal,
    ).catch(() => {});
    if (!verified || unsafe || signal.aborted)
      throw new Error("Tool-free suggestion invocation unavailable");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const resultSchema = z.object({ text: z.string().max(240) }).strict();
export async function generateSuggestion(
  messages: Message[],
  signal: AbortSignal,
  selection: GenerationSettings = DEFAULT_GENERATION_SETTINGS,
): Promise<string | null> {
  const latestUserRequest = messages.findLast((message) => message.role === "user")?.text ?? "";
  if (!latestUserRequest.trim()) return null;
  const directory = await mkdtemp(join(tmpdir(), "paseo-follow-up-"));
  let stage = "catalogue";
  try {
    const settings = generationSettingsSchema.parse(selection);
    // Freeze the exact local model contract for both probe and generation. No fallback model.
    const cachePath = join(
      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "models_cache.json",
    );
    if ((await stat(cachePath)).size > 4_000_000) throw new Error("Model catalogue too large");
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    const model = cache.models?.find((entry: { slug?: string }) => entry.slug === settings.model);
    if (!model) throw new Error("Small model unavailable");
    if (
      !model.supported_reasoning_levels?.some(
        (level: { effort?: string }) => level.effort === settings.reasoningEffort,
      )
    )
      throw new Error("Thinking level unavailable");
    await writeFile(join(directory, "models.json"), JSON.stringify({ models: [model] }), {
      mode: 0o600,
    });
    const args = generationArgs(directory, settings);
    stage = "preflight";
    await verifyToolFree(args, directory, signal, settings.model);
    const schema = join(directory, "schema.json");
    const output = join(directory, "result.json");
    await writeFile(
      schema,
      JSON.stringify({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      }),
      { mode: 0o600 },
    );
    stage = "generation";
    await runCommand(
      [...args, "--output-schema", schema, "--output-last-message", output, "-"],
      directory,
      generationPrompt(messages),
      signal,
    );
    if (signal.aborted) throw new Error("Generation canceled");
    stage = "validation";
    if ((await stat(output)).size > 4_096) throw new Error("Result too large");
    const { text } = resultSchema.parse(JSON.parse(await readFile(output, "utf8")));
    const trimmed = text.trim();
    if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(trimmed)) throw new Error("Invalid suggestion");
    const mismatch = hasLanguageMismatch(latestUserRequest, trimmed);
    trace("model-result", {
      characters: trimmed.length,
      result: !trimmed ? "empty" : mismatch ? "language-mismatch" : "accepted",
      requestLanguage: detectLanguage(latestUserRequest),
      suggestionLanguage: detectLanguage(trimmed),
    });
    return trimmed && !mismatch ? trimmed : null;
  } catch {
    trace("model-failed", { stage, canceled: signal.aborted });
    throw new Error(
      "Suggestion generation unavailable. Check Codex login, small model access and CLI compatibility on this host.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
