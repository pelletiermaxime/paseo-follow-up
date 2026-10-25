// Operational metadata only. Never pass conversation text, provider output or error objects.
export function trace(
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  console.info(`[follow-up] ${event} ${JSON.stringify(fields)}`);
}
