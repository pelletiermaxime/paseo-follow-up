import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { readContext } from "../server/history";
import { entry } from "./helpers";

type Page = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>;
function page(entries: ReturnType<typeof entry>[], extra: Partial<Page> = {}): Page {
  return {
    entries,
    epoch: "epoch-1",
    staleCursor: false,
    gap: false,
    hasOlder: false,
    startCursor: { epoch: "epoch-1", seq: entries[0]?.seqEnd ?? 1 },
    ...extra,
  } as Page;
}
describe("bounded user-request recovery", () => {
  it("reads an older page when tools push the user's English request out of the tail", async () => {
    const refetch = vi
      .fn<PaseoAgentTimelineHandle["refetch"]>()
      .mockResolvedValueOnce(
        page(
          [
            entry("tool_call", "excluded", 21),
            entry("assistant_message", "Terminé. Vérifie le compositeur.", 40),
          ],
          { hasOlder: true },
        ),
      )
      .mockResolvedValueOnce(page([entry("user_message", "Please implement the feature.", 1)]));
    expect(await readContext({ refetch }, "turn-1", new AbortController().signal)).toEqual([
      { role: "user", text: "Please implement the feature." },
      { role: "assistant", text: "Terminé. Vérifie le compositeur." },
    ]);
    expect(refetch).toHaveBeenNthCalledWith(2, {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 21 },
      limit: 20,
    });
  });
  it("skips generation instead of guessing when the request is outside the five-page bound", async () => {
    const refetch = vi.fn<PaseoAgentTimelineHandle["refetch"]>();
    for (let index = 0; index < 5; index++)
      refetch.mockResolvedValueOnce(
        page([entry("assistant_message", "Progress update", 100 - index * 20)], { hasOlder: true }),
      );
    expect(await readContext({ refetch }, "turn-1", new AbortController().signal)).toEqual([]);
    expect(refetch).toHaveBeenCalledTimes(5);
  });
  it("stops after cancellation during a fetch", async () => {
    const controller = new AbortController();
    const refetch = vi.fn<PaseoAgentTimelineHandle["refetch"]>(async () => {
      controller.abort();
      return page([entry("assistant_message", "Answer", 20)], { hasOlder: true });
    });
    expect(await readContext({ refetch }, "turn-1", controller.signal)).toEqual([]);
    expect(refetch).toHaveBeenCalledOnce();
  });
  it.each([{ staleCursor: true }, { gap: true }])(
    "rejects discontinuous history: %j",
    async (extra) => {
      const refetch = vi
        .fn<PaseoAgentTimelineHandle["refetch"]>()
        .mockResolvedValue(
          page(
            [entry("user_message", "Question", 1), entry("assistant_message", "Answer", 2)],
            extra,
          ),
        );
      expect(await readContext({ refetch }, "turn-1", new AbortController().signal)).toEqual([]);
    },
  );
});
