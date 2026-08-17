import { z } from "zod";

export const nonprofitMessageSchema = z.object({
  workflow: z.enum(["donor_receipt", "volunteer_reminder", "campaign_report"]),
  recipientName: z.string().trim().min(1).max(100),
  facts: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  tone: z.enum(["warm", "direct"]).default("warm")
}).strict();

export type NonprofitMessage = z.infer<typeof nonprofitMessageSchema>;

const workflowInstructions: Record<NonprofitMessage["workflow"], string> = {
  donor_receipt:
    "Write a donor receipt note. Preserve every supplied amount and date exactly, identify the gift, and include no invented tax or legal claims.",
  volunteer_reminder:
    "Write a volunteer reminder. Put the date, arrival time, location, and requested action near the beginning; say when a required detail was not supplied.",
  campaign_report:
    "Write a concise campaign report. Separate observed results from remaining work, retain supplied metrics exactly, and do not manufacture totals."
};

export function buildNonprofitPrompt(input: NonprofitMessage) {
  const facts = input.facts.map((fact) => `- ${fact}`).join("\n");

  return [
    workflowInstructions[input.workflow],
    `Address the reader as ${input.recipientName}. Use a ${input.tone} tone.`,
    "Treat these facts as the complete source of truth:",
    facts,
    "Return only the finished message in plain text."
  ].join("\n\n");
}
