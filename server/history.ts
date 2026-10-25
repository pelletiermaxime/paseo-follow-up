import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { extractContext, type Message } from "./context";

// Tool-heavy turns can put the user's request outside the newest page. Read only enough
// bounded history to find it; without that request, do not guess the suggestion's language.
export async function readContext(
  timeline: Pick<PaseoAgentTimelineHandle, "refetch">,
  turnId: string,
  signal: AbortSignal,
): Promise<Message[]> {
  const entries: Parameters<typeof extractContext>[0][number][] = [];
  let cursor: { epoch: string; seq: number } | undefined;
  let epoch: string | undefined;
  for (let page = 0; page < 5; page++) {
    if (signal.aborted) return [];
    const history = await timeline.refetch({
      direction: cursor ? "before" : "tail",
      ...(cursor ? { cursor } : {}),
      limit: 20,
    });
    if (signal.aborted || history.staleCursor || history.gap || (epoch && epoch !== history.epoch))
      return [];
    epoch = history.epoch;
    entries.unshift(...history.entries);
    if (history.entries.some(({ item }) => item.type === "user_message"))
      return extractContext(entries, turnId);
    if (!history.hasOlder || !history.startCursor || history.startCursor.seq === cursor?.seq)
      return [];
    cursor = history.startCursor;
  }
  return [];
}
