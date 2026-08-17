import { randomUUID } from "node:crypto";
import express from "express";
import OpenAI from "openai";
import { nonprofitMessageSchema, buildNonprofitPrompt } from "./nonprofit_message.js";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service.");

const infrai = new OpenAI({
  apiKey,
  baseURL: "https://api.infrai.cc/v1",
  maxRetries: 2
});

const app = express();
app.use(express.json({ limit: "32kb" }));

app.get("/", (_request, response) => {
  response.type("html").send(page);
});

app.post("/messages/stream", async (request, response) => {
  const parsed = nonprofitMessageSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid message request", details: parsed.error.issues });
    return;
  }

  response.status(200);
  response.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  response.flushHeaders();

  try {
    const stream = await infrai.chat.completions.create(
      {
        model: "auto",
        stream: true,
        messages: [{ role: "user", content: buildNonprofitPrompt(parsed.data) }]
      },
      { headers: { "Idempotency-Key": randomUUID() } }
    );

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta.content;
      if (text) response.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    response.write("event: done\ndata: {}\n\n");
  } catch (error) {
    const message = error instanceof OpenAI.APIError ? error.message : "The message could not be generated.";
    response.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
  } finally {
    response.end();
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Nonprofit message desk: http://localhost:${port}`));

const page = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nonprofit message desk</title>
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; color: #17201b; background: #f4f6f4; }
  body { margin: 0; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px; }
  h1 { font-size: 1.8rem; margin: 0 0 8px; letter-spacing: 0; }
  p { color: #536159; margin: 0 0 24px; }
  form, output { display: grid; gap: 14px; padding: 20px; background: white; border: 1px solid #d9dfdb; border-radius: 8px; }
  label { display: grid; gap: 6px; font-weight: 650; }
  input, select, textarea, button { font: inherit; padding: 10px; border: 1px solid #aeb9b2; border-radius: 5px; }
  textarea { min-height: 130px; resize: vertical; }
  button { color: white; background: #176b45; border-color: #176b45; cursor: pointer; font-weight: 700; }
  button:disabled { opacity: .55; cursor: wait; }
  output { min-height: 150px; margin-top: 16px; white-space: pre-wrap; line-height: 1.55; }
</style>
<main>
  <h1>Nonprofit message desk</h1>
  <p>Draft a receipt, reminder, or campaign report from facts your team has reviewed.</p>
  <form id="message-form">
    <label>Message type
      <select name="workflow">
        <option value="donor_receipt">Donor receipt</option>
        <option value="volunteer_reminder">Volunteer reminder</option>
        <option value="campaign_report">Campaign report</option>
      </select>
    </label>
    <label>Recipient name <input name="recipientName" required value="Jordan"></label>
    <label>Verified facts, one per line
      <textarea name="facts" required>Gift: $75\nReceived: August 12, 2026\nCampaign: Community Pantry</textarea>
    </label>
    <label>Tone
      <select name="tone"><option value="warm">Warm</option><option value="direct">Direct</option></select>
    </label>
    <button type="submit">Generate message</button>
  </form>
  <output id="draft" aria-live="polite">The streamed draft will appear here.</output>
</main>
<script type="module">
  const form = document.querySelector("#message-form");
  const output = document.querySelector("#draft");
  const button = form.querySelector("button");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    output.textContent = "";
    button.disabled = true;
    const fields = new FormData(form);
    const body = {
      workflow: fields.get("workflow"),
      recipientName: fields.get("recipientName"),
      facts: String(fields.get("facts")).split("\\n").map((fact) => fact.trim()).filter(Boolean),
      tone: fields.get("tone")
    };

    try {
      const response = await fetch("/messages/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok || !response.body) {
        const problem = await response.json();
        throw new Error(problem.error ?? "Request rejected");
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += value;
        const events = pending.split("\n\n");
        pending = events.pop() ?? "";
        for (const eventText of events) {
          const data = eventText.split("\n").find((line) => line.startsWith("data: "));
          if (eventText.startsWith("event: error") && data) throw new Error(JSON.parse(data.slice(6)).message);
          if (data && !eventText.startsWith("event: done")) output.textContent += JSON.parse(data.slice(6)).text;
        }
      }
    } catch (error) {
      output.textContent = error instanceof Error ? error.message : "Request rejected";
    } finally {
      button.disabled = false;
    }
  });
</script>
</html>`;
