import { describe, expect, it } from "vitest";
import { buildNonprofitPrompt, nonprofitMessageSchema } from "../src/nonprofit_message.js";

describe("nonprofit message policy", () => {
  it("makes a volunteer reminder actionable without inventing missing logistics", () => {
    const input = nonprofitMessageSchema.parse({
      workflow: "volunteer_reminder",
      recipientName: "Mina",
      facts: ["Shift date: September 8", "Location: West Hall"],
      tone: "direct"
    });

    const prompt = buildNonprofitPrompt(input);

    expect(prompt).toContain("date, arrival time, location, and requested action near the beginning");
    expect(prompt).toContain("say when a required detail was not supplied");
    expect(prompt).toContain("- Shift date: September 8\n- Location: West Hall");
  });

  it("rejects extra fields at the public request boundary", () => {
    const result = nonprofitMessageSchema.safeParse({
      workflow: "donor_receipt",
      recipientName: "Ari",
      facts: ["Gift: $50"],
      tone: "warm",
      taxStatus: "deductible"
    });

    expect(result.success).toBe(false);
  });
});
