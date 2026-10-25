import { describe, expect, it } from "vite-plus/test";
import { detectLanguage, hasLanguageMismatch } from "../server/language";
import { generationPrompt } from "../server/context";

describe("suggestion language", () => {
  it("detects English from the user's own text despite a longer French quotation", () => {
    expect(
      detectLanguage(
        'Please review this English request. The quoted message says: "Peux-tu montrer un exemple complet pour expliquer comment cette fonction traite les données et affiche le résultat ?"',
      ),
    ).toBe("en");
  });
  it("ignores code and blockquotes when choosing the request language", () => {
    expect(
      detectLanguage(
        "Please help me verify keyboard acceptance.\n> Peux-tu vérifier le compositeur ?\n```text\nLe test manuel fonctionne.\n```",
      ),
    ).toBe("en");
  });
  it("preserves French when the user actually requests it in French", () => {
    expect(
      detectLanguage("Peux-tu expliquer comment vérifier le compositeur sans envoyer de message ?"),
    ).toBe("fr");
  });
  it("recognizes a French suggestion", () => {
    expect(
      detectLanguage(
        "Peux-tu montrer un exemple complet pour expliquer comment cette fonction traite les données et affiche le résultat ?",
      ),
    ).toBe("fr");
  });
  it("reports missing or ambiguous language evidence without inventing a language", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("OK")).toBeNull();
    expect(detectLanguage('"Peux-tu vérifier le compositeur ?"')).toBeNull();
  });
  it("does not suppress a valid suggestion after a short English request with weak scores", () => {
    const request = "remove the notes about the settings at the end";
    expect(detectLanguage(request)).toBeNull();
    expect(hasLanguageMismatch(request, "Can you show me the updated prompt?")).toBe(false);
  });
  it("does not reject short English suggestions just because their language score is weak", () => {
    expect(detectLanguage("Show an example.")).toBeNull();
    expect(
      hasLanguageMismatch("Please help me verify keyboard acceptance.", "Show an example."),
    ).toBe(false);
  });
  it("rejects a clear mismatch while accepting a clear match", () => {
    const request = "Please help me verify keyboard acceptance.";
    expect(
      hasLanguageMismatch(
        request,
        "Peux-tu montrer un exemple complet pour expliquer comment cette fonction traite les données et affiche le résultat ?",
      ),
    ).toBe(true);
    expect(
      hasLanguageMismatch(
        request,
        "Can you walk me through accepting the suggestion with the keyboard without sending the message?",
      ),
    ).toBe(false);
  });
  it("does not append language directives to the generation prompt", () => {
    const prompt = generationPrompt([
      {
        role: "user",
        text: 'Please help me verify keyboard acceptance. A previous suggestion said "Peux-tu me guider pour faire le dernier test manuel ?".',
      },
      { role: "assistant", text: "Le test manuel consiste à vérifier le compositeur." },
    ]);
    expect(prompt).not.toContain("REQUIRED OUTPUT LANGUAGE:");
    expect(prompt).not.toContain("LANGUAGE:");
    expect(prompt).not.toContain("language anchor");
  });
});
