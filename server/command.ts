import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";

// Never retain or propagate provider stderr/stdout. The schema result is read separately.
export async function runCommand(
  args: string[],
  cwd: string,
  input: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error("Generation canceled");
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess("codex", args, {
      cwd,
      env: { ...process.env, CODEX_SQLITE_HOME: cwd },
      stdio: "pipe",
    });
    let bytes = 0;
    let failed = false;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      failed = true;
      void terminateProcess(child, "SIGKILL").catch(() => {});
    };
    const timer = setTimeout(stop, 30_000);
    signal.addEventListener("abort", stop, { once: true });
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128_000) stop();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || code !== 0 || signal.aborted) reject(new Error("Luna generation unavailable"));
      else resolve();
    });
  });
}
