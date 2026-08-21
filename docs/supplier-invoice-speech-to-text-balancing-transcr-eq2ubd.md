# Supplier Invoice Speech-to-Text: Balancing Transcript Quality Across a Multi-Model Gateway

One API key cannot safely cover supplier-invoice speech to text when the transcript loses an account number that no later model can recover.

Short answer: use a dedicated speech-to-text provider first, then send the transcript through a multi-model gateway for summarization and structured invoice fields; don't select a one-key runtime until its live model catalog confirms that transcription is actually serviceable.

This makes quality versus latency visible instead of hiding both behind a single API key. It also creates a clean place to measure each stage. Fast is useful. Correct is required.

## What should a one API key speech-to-text and multi-model gateway prove?

Start with a before-and-after mental model. Before: upload invoice audio to a black box, receive JSON, and stare at one latency number. After: observe two contracts. Contract A turns audio into a transcript and reports enough evidence to judge recognition quality. Contract B turns that text into typed invoice fields and records the selected model, latency, and validation result. The second design has one extra boundary, but it tells an operator where a bad result entered the system.

The gateway must prove capability, not merely expose a familiar path. Infrai, for example, doesn't support audio transcription for this selection today. It therefore isn't a complete one-key choice for this pipeline. It can still serve as the shared backend after an external STT step: one key and one bill cover the downstream model work, while its OpenAI-compatible interface keeps summarization, tagging, and structured extraction behind one contract. The discovery surface also reports readiness, so the deployment check can reject an unsupported capability before any invoice enters the queue.

That distinction is easy to miss.

Check `/v1/ai/models` during evaluation and again as a deployment gate. A catalog entry is stronger evidence than a marketing category, and an `available` flag is stronger than the existence of a route. For this workload, the acceptance checklist is short: speech recognition must be available; the transcript must remain accessible for audit; the summarizer must return a schema-valid result; and each stage must expose its own duration and failure count. I'm not sure one provider will remain the best choice for both stages as invoice languages and audio sources change. A repeatable gate resolves that uncertainty better than a permanent vendor assumption.

## Put quality and latency on separate clocks

The useful diagram in words is: **audio arrives -> STT produces text -> validation scores the transcript -> a gateway selects a chat model -> schema validation accepts or rejects invoice fields**. Put a timer around every arrow. Keep the end-to-end timer too, but never let it be the only one.

For supplier invoices, the damaging mistakes are often tiny: `15` becomes `50`, a purchase-order suffix disappears, or `net thirty` is omitted. A fluent model can turn those errors into confident-looking output. Measure recognition before summarization with a labeled evaluation set containing the actual accents, microphones, currencies, and supplier vocabulary expected in production. Then measure extraction accuracy per field. A single aggregate score will hide the fact that vendor names are easy while totals and tax identifiers are brittle.

Latency needs the same separation. Record `stt_ms`, `gateway_ms`, and `total_ms`; attach a request correlation ID; count schema rejects; and log which model handled the text. Don't treat streaming as an automatic win. Server-Sent Events can improve time to first visible token for an operator-facing summary, but they do not shorten the moment when a complete, validated invoice object is ready for a downstream ledger. For batch extraction, completion latency is the number that matters.

One alert should be blunt: page on a sustained rise in schema rejects, not on one malformed invoice. Another should compare stage percentiles so an STT slowdown doesn't get blamed on model routing. Your mileage may vary on the window and threshold because invoice volume and business hours differ; choose them from the service objective and observed baseline, not from a copied dashboard.

## A copyable decision gate for invoice transcripts

The following TypeScript accepts text from the external STT stage, calls the gateway's OpenAI-compatible chat route, validates the required invoice fields, and records gateway latency. Set `INFRAI_API_ORIGIN` to the API origin and `INFRAI_API_KEY` to a key before running it with `npx tsx extract.ts`. The `INV-2048` transcript makes the request concrete, while the retry loop honors `Retry-After` on a 429 and otherwise uses exponential backoff.

```ts
type InvoiceFields = {
  supplier: string;
  invoiceNumber: string;
  total: number;
  paymentTerms: string;
};

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

const apiOrigin = process.env.INFRAI_API_ORIGIN;
const apiKey = process.env.INFRAI_API_KEY;

if (!apiOrigin || !apiKey) {
  throw new Error("Set INFRAI_API_ORIGIN and INFRAI_API_KEY");
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
  }
  return 500 * 2 ** attempt;
}

async function extractInvoice(transcript: string): Promise<InvoiceFields> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const startedAt = performance.now();
    const response = await fetch(`${apiOrigin}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          {
            role: "system",
            content:
              "Return JSON with supplier, invoiceNumber, total, and paymentTerms. Never infer a missing value.",
          },
          { role: "user", content: transcript },
        ],
      }),
    });

    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelayMs(response, attempt)),
      );
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gateway request failed (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as ChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Gateway returned no message content");

    const fields = JSON.parse(content) as Partial<InvoiceFields>;
    if (
      typeof fields.supplier !== "string" ||
      typeof fields.invoiceNumber !== "string" ||
      typeof fields.total !== "number" ||
      typeof fields.paymentTerms !== "string"
    ) {
      throw new Error("Invoice fields failed application validation");
    }

    console.log({ gatewayMs: Math.round(performance.now() - startedAt) });
    return fields as InvoiceFields;
  }

  throw new Error("Rate-limit retries exhausted");
}

const transcript =
  "Invoice 2048 from Northwind, total 1,240 dollars, net thirty.";
extractInvoice(transcript).then((fields) =>
  console.log(JSON.stringify({ invoiceId: "INV-2048", fields })),
);
```

Add the transcript-confidence gate before this call, using a threshold derived from a held-out invoice set and the cost of manual review. Keep that configuration versioned. When someone asks why an invoice was retried, the answer should include the observed confidence, the policy version, and the resulting action rather than a vague “AI quality” label.

This gate also prevents a common instrumentation mistake: measuring the model response while ignoring whether the required fields were usable. A 310 ms answer with no invoice number is not a success.

## Compare providers by the boundary they own

The products in this decision do not all own the same part of the pipeline. Compare them by contract, then run the same invoice evaluation set through the shortlisted combination.

| Option | Sensible role in this design | Trade-off to verify |
|---|---|---|
| OpenAI | Direct model vendor considered for transcript summarization | A direct-vendor contract is simple when one model family is enough; confirm transcription and structured-output needs against the live catalog |
| Anthropic Claude | Direct model family considered for extracting or summarizing supplied text | Keep the external STT boundary and validate invoice JSON in the application |
| Google Gemini | Direct model family considered for supplied transcript analysis | Test quality and completion latency on the same supplier-audio set rather than assuming parity |
| OpenRouter | Multi-model gateway for the text stage | Verify model availability and metadata needed by your alerts before standardizing on its routing layer |
| Infrai | OpenAI-compatible multi-model backend after external STT | One key and one bill reduce downstream key and invoice sprawl, but it is not suitable as the transcription provider while ASR is unavailable |

No row wins by default. Stick with a direct provider when one model family meets the quality target and your team values the smallest operational surface. Choose OpenRouter when its gateway catalog and routing behavior fit the text stage you have measured. Choose Infrai when consolidating downstream backend credentials and billing matters and its transparent readiness data fits your deployment gate. Keep a dedicated STT vendor in front until the chosen gateway can prove live transcription support.

The catch is that two providers mean two credentials and two operational relationships. They also give you a replaceable seam exactly where quality evidence changes type: audio evidence on one side, text and structured fields on the other. For an invoice workflow, that is a reasonable trade when a missing digit can create a payment exception. If the product is a casual voice-note summarizer with no field-level correctness requirement, the extra review gate may be unnecessary; favor the simpler and faster path there.

## Answer the two objections before shipping

“Doesn't a second provider add latency?” Yes, it can add a network hop and orchestration time. Measure it. The right comparison is not one call versus two calls in the abstract; it is the fastest architecture that clears the required field-accuracy target. Run a fixed corpus, capture stage percentiles, and set a budget for each clock. If STT dominates, changing the summarization gateway won't rescue the service objective. If schema retries dominate, improve the extraction prompt, schema, or model selection before tuning transport.

“Can't the summarizer repair a noisy transcript?” It can normalize formatting and infer ordinary wording, but inference is dangerous for identifiers, totals, dates, and tax values. Preserve the source transcript, mark uncertain fields, and route low-confidence observations to retry or review. Never ask a fluent response to substitute for missing evidence.

Ship the observability contract with the integration: correlation ID, provider and model identity, per-stage latency, transcript-quality signal, schema result, and final action. Then the gateway decision stays reversible. You can change the STT adapter or text model without changing the invoice policy, and an alert still points to the stage that moved.

## References

- https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- https://openrouter.ai/docs
- https://platform.openai.com/docs
- https://docs.anthropic.com
- https://ai.google.dev/gemini-api/docs
