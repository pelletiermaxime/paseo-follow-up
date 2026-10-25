import { detectAll } from "tinyld";

// Infer from the user's own prose, not a translated suggestion, quoted reply or code sample.
export function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”|«[^»]*»/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
}
export function detectLanguage(text: string): string | null {
  const ownWords = prose(text);
  if (ownWords.length < 12) return null;
  const [first, second] = detectAll(ownWords);
  if (!first || first.accuracy < 0.7 || (second && first.accuracy - second.accuracy < 0.2))
    return null;
  return first.lang;
}

export function hasLanguageMismatch(request: string, suggestion: string): boolean {
  const requested = detectLanguage(request);
  if (!requested) return false;
  const generated = detectLanguage(suggestion);
  // Short text often has weak language scores. Uncertainty is not evidence of a mismatch.
  return generated !== null && generated !== requested;
}
