import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { runCommand } from "../server/command";
vi.mock("@getpaseo/plugin/server", () => ({
  spawnProcess: vi.fn(),
  terminateProcess: vi.fn(async () => {}),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
function child() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawnProcess).mockReturnValue(process as unknown as ReturnType<typeof spawnProcess>);
  vi.mocked(terminateProcess).mockImplementation(async () => {
    process.emit("close", null);
  });
  return process;
}
describe("bounded Codex subprocess", () => {
  it("sends conversation only over stdin, closes it and discards provider output", async () => {
    const process = child();
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    const result = runCommand(
      ["exec", "-"],
      "/tmp",
      "quoted conversation",
      new AbortController().signal,
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      "codex",
      ["exec", "-"],
      expect.objectContaining({ cwd: "/tmp", stdio: "pipe" }),
    );
    expect(input).toBe("quoted conversation");
    expect(process.stdin.writableEnded).toBe(true);
    process.stderr.write("private raw provider error");
    process.emit("close", 1);
    await expect(result).rejects.toThrow("Suggestion generation unavailable");
    await expect(result).rejects.not.toThrow("private raw provider error");
  });
  it("kills the subprocess on cancellation", async () => {
    child();
    const controller = new AbortController();
    const result = runCommand([], "/tmp", "data", controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(terminateProcess).toHaveBeenCalledOnce();
  });
  it("rejects before spawning an already obsolete request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCommand([], "/tmp", "data", controller.signal)).rejects.toThrow();
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it("kills noisy subprocesses before retaining their output", async () => {
    const process = child();
    const result = runCommand([], "/tmp", "data", new AbortController().signal);
    process.stdout.write(Buffer.alloc(128_001));
    await expect(result).rejects.toThrow();
    expect(terminateProcess).toHaveBeenCalledOnce();
  });
  it("enforces a wall-clock deadline", async () => {
    vi.useFakeTimers();
    child();
    const result = runCommand([], "/tmp", "data", new AbortController().signal);
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(terminateProcess).toHaveBeenCalledOnce();
  });
  it("terminates only once when output overflow and cancellation overlap", async () => {
    const process = child();
    vi.mocked(terminateProcess).mockResolvedValue();
    const controller = new AbortController();
    const result = runCommand([], "/tmp", "data", controller.signal);
    process.stdout.write(Buffer.alloc(128_001));
    process.stderr.write(Buffer.alloc(128_001));
    controller.abort();
    process.emit("close", null);
    await expect(result).rejects.toThrow("Suggestion generation unavailable");
    expect(terminateProcess).toHaveBeenCalledOnce();
  });
});
