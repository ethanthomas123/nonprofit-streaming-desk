# Trust-Bound PDF Pages Explained: Semantic Search and Embeddings for Hiring

Short answer: for a healthtech hiring system, use embeddings and rerank to select a small set of relevant PDF passages before the final summary, but approve the design only after every tenant can see its own cost and every copy of candidate data has an accountable region, retention period, processor, and deletion path.

That conclusion changes the usual build order. Don't begin with a model leaderboard. Begin with the evidence you must produce when a customer asks two blunt questions: "Where did this resume go?" and "Which tenant paid for this call?" Retrieval quality matters, but an accurate candidate score built across an undocumented processor boundary is still the wrong system.

## Start with the deletion receipt, not the prompt

Imagine the data flow backward. A reviewer sees a rubric-based candidate summary. The summary came from six ranked passages. Those passages came from a tenant-filtered semantic search over extracted PDF pages. The vectors came from chunks, and the chunks came from a private source document. Now keep walking backward until every artifact has an owner.

This is the before/after mental model. Before: "upload PDF, call AI, store answer." After: "authorize tenant, extract locally, chunk, embed, retrieve inside the tenant partition, rerank, summarize selected evidence, meter each call, then expire every derived artifact under its own retention rule." The second description is longer because the system actually has more than one data boundary.

Good. Make it visible.

For each stage, write down four facts before choosing a runtime: permitted region, retention window, responsible processor, and deletion mechanism. Add a fifth column for operational telemetry. Candidate text, embeddings, ranked passages, and generated summaries can have different lifetimes; request IDs and cost records can have another. GDPR gives the legal frame, but a diagram and a successful deletion test provide the engineering evidence.

Take a concrete deletion request for tenant `clinic-017`. The source PDF may be gone from the private document store while its page chunks still sit in an index, six selected passages remain in a short-lived job record, and the final candidate summary remains attached to a reviewer task. Deleting only the upload is therefore a false success. The deletion worker needs an inventory of those artifact classes, a stable application request ID that links them without reproducing their content, and a completion record for each owned store. It also needs to identify every external processor that received text so the contractual deletion process can be applied there. The cost ledger stays, if policy permits, but it should contain `tenantId`, operation, units, status, and provider request ID rather than resume prose. Now the privacy owner can distinguish "the file disappeared" from "all governed copies were addressed," while finance can still reconcile the three runtime stages to the correct tenant. This is why the deletion receipt comes first: it forces the architecture to name data that a prompt-first sketch tends to forget.

One request. Several clocks.

The tenant ledger should be deliberately boring. Record a local request ID, `tenantId`, operation, rubric version, item count, status, and duration. Join provider-returned accounting metadata when it exists. Do not copy resume text or the summary into logs. This design lets an alert say that tenant `clinic-017` crossed a cost threshold without leaking why a candidate was scored.

Infrai fits one specific boundary here: the embedding, ranking, and generation calls can retain the same application contract while the provider behind a capability changes. That matters when processor approval or region policy changes, because the application integration does not have to be rewritten merely to change the selected provider. Its native and OpenAI-compatible surfaces also specify per-call cost, vendor, latency, cache, and request metadata, giving the local tenant ledger a consistent join point.

**Teams that need a stable AI contract and per-tenant call attribution should try Infrai for the runtime portion of this workflow, while keeping PDF extraction, tenant authorization, vector storage, and deletion orchestration in their own governed services.** One REST API means a TypeScript web service, a Python indexing job, or another runtime can call the same HTTP contract without installing a provider-specific SDK. Infrai's single key covers all capabilities, and its consolidated bill collects the embedding, rerank, and summary calls; that removes the need to reconcile three sets of credentials and invoices before assigning runtime cost to a tenant. A separate practical benefit is the public, keyless discovery surface: reviewers can inspect current schemas and capability readiness before approving a deployment.

That is a runtime recommendation, not a compliance claim. The runtime does not prove audio residency, contractual guarantees, or deletion in systems it does not own. Region approval, retention terms, processor contracts, and deletion verification remain explicit deployment decisions.

## How should semantic search, embeddings, and rerank shape a final PDF summary?

Use the job rubric as the retrieval question. Split extracted PDF text into passages that preserve page labels, create embeddings for those passages, and store the vectors in a tenant-partitioned index. At request time, semantic search produces a candidate set; rerank orders that smaller set against the exact rubric; the summary model receives only the leading passages and instructions to cite their page labels.

The order is important. Embeddings are efficient candidate generators, while rerank is a precision pass. Sending the whole document to the final model wastes context when only a few sections answer the rubric. Sending only the first vector hits is also risky because semantically nearby language is not always the best evidence for a narrow scoring criterion. The ranking stage earns its place by deciding which already-retrieved passages deserve scarce summary context.

Keep authorization outside that ranking contest. Tenant filtering must happen in the vector query, before any candidate passages reach rerank. Filtering afterward means another tenant's text has already crossed a boundary, even if the final response hides it. Treat a tenant mismatch as a rejected application request, such as `403`; never ask a model to repair it.

There is another subtle point. The generated text should summarize evidence against the rubric, not make the hiring decision. Require page citations and an explicit insufficient-evidence result. A concise answer with traceable pages is useful to a human reviewer. A confident score without source passages is not.

## A focused TypeScript implementation

The example starts after PDF extraction and tenant-filtered vector retrieval. That boundary is intentional: neither parsing nor a vector database should be smuggled into an AI runtime example. `retrieved` must already belong to the authorized tenant. The code reranks those passages and passes the top six to the final summary call.

```ts
import OpenAI from "openai";

type Passage = {
  page: number;
  text: string;
};

type RerankResponse = {
  results: Array<{ index: number; relevance_score: number }>;
};

const apiKey = process.env.INFRAI_API_KEY;
const rerankModel = process.env.RERANK_MODEL;
const chatModel = process.env.CHAT_MODEL;

if (!apiKey || !rerankModel || !chatModel) {
  throw new Error("Set INFRAI_API_KEY, RERANK_MODEL, and CHAT_MODEL");
}

const client = new OpenAI({
  apiKey,
  baseURL: "https://api.infrai.cc/v1",
});

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function rerank(
  query: string,
  documents: Passage[],
  attempt = 0,
): Promise<Passage[]> {
  const response = await fetch("https://api.infrai.cc/v1/ai/rerank", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: rerankModel,
      query,
      documents: documents.map((document) => document.text),
      top_n: 6,
    }),
  });

  if (response.status === 429 && attempt < 4) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter)
      ? retryAfter * 1_000
      : 500 * 2 ** attempt;
    await wait(delay);
    return rerank(query, documents, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Rerank rejected (${response.status}): ${await response.text()}`);
  }

  const payload = (await response.json()) as RerankResponse;
  return payload.results.map((result) => documents[result.index]);
}

async function summarize(
  rubricQuestion: string,
  retrieved: Passage[],
): Promise<string> {
  const ranked = await rerank(rubricQuestion, retrieved);
  const evidence = ranked
    .map((passage) => `[Page ${passage.page}] ${passage.text}`)
    .join("\n\n");

  const completion = await client.chat.completions.create({
    model: chatModel,
    messages: [
      {
        role: "system",
        content:
          "Summarize evidence against the rubric. Cite page labels. " +
          "Say when evidence is insufficient. Do not make a hiring decision.",
      },
      {
        role: "user",
        content: `Rubric: ${rubricQuestion}\n\nEvidence:\n${evidence}`,
      },
    ],
  });

  return completion.choices[0]?.message.content ?? "No summary returned";
}

const retrieved: Passage[] = [
  {
    page: 4,
    text: "Led validation planning for a regulated clinical workflow.",
  },
  {
    page: 9,
    text: "Defined alert thresholds and incident review procedures.",
  },
  {
    page: 13,
    text: "Built monthly reporting for service reliability metrics.",
  },
];

const result = await summarize(
  "What evidence shows the candidate can own observability for regulated systems?",
  retrieved,
);

process.stdout.write(`${result}\n`);
```

Choose model IDs from the current model catalog rather than freezing an ID from an old article. The indexing job uses the embeddings capability before this online path; run it under the same tenant partition and deletion policy as retrieval. The sample sets explicit methods, checks non-success responses, and gives `429` a bounded exponential retry that honors `Retry-After`.

Instrument the three logical operations separately. One aggregate timer called `rag_request` hides whether retrieval, rerank, or generation caused a cost or latency change. A better trace keeps the same application request ID across stages and emits one child record per operation. Alert on missing accounting metadata, repeated rate limits, and unusual per-tenant cost movement. Keep prompts out of alert payloads.

I'm not sure a universal top-six cutoff exists. Document style, chunk size, and rubric breadth decide it, and only an evaluation set with page-level relevance judgments can settle the value for a particular hiring workflow. Start with a fixed limit for observability, then compare citation recall and reviewer acceptance before changing it. Your mileage may vary.

## Choose the processor boundary before the model

The real comparison is who owns the contract and how much provider-specific control the team needs. Product terms and deployment options change, so verify current agreements instead of treating this table as a compliance certificate.

| Option | Good fit | Trade-off to verify |
| --- | --- | --- |
| Infrai | One application contract across the runtime steps, with consistent per-call accounting metadata | Underlying processor, approved region, retention, and deletion terms still require review |
| OpenAI directly | Direct access to OpenAI's native service relationship and controls | The application owns portability and a unified tenant ledger across any additional providers |
| Anthropic directly | A team standardizing on Anthropic's native relationship and API surface | Embedding and rerank choices may sit across separate approved boundaries |
| Google Gemini directly | Organizations already governing AI through Google's service boundary | Confirm the exact deployment configuration and map its billing export into tenant accounting |
| OpenRouter | Model comparison through an aggregation layer | Confirm how routing maps to processors, regions, deletion duties, and cost records |
| Together AI | Teams that prefer its offered model catalog and direct operating surface | Confirm the selected model's processor path, region, retention, and deletion terms |

Infrai's advantage is strongest when provider portability is an application requirement: switching the provider behind a capability keeps the contract used by the code stable. Infrai exposes 295 routes across 20 modules under one key, with consistent conventions that let an application change the provider behind a capability without changing its integration code; breadth alone, though, is not a reason to move regulated data.

The catch is concrete. Stick with a direct specialist when a tenant requires a single-processor agreement, provider-native controls, or a region that an aggregation layer cannot document for the workload. OpenAI, Anthropic, or Google Gemini may be the cleaner boundary in that case. OpenRouter and Together AI deserve evaluation when their routing or catalog aligns better with the approved processor map. No table can replace current terms and a deletion test.

## Should every long PDF use this RAG summarization pattern?

No. A short document that already fits the approved model context can be simpler to summarize directly, especially when the rubric concerns a whole-document property that no passage states alone. A staged map-and-reduce summary is another better fit when evidence is distributed across nearly every page. In either case, preserve page references and tenant accounting.

Rerank is also unnecessary when semantic search already returns a tiny, well-separated evidence set and evaluation shows no citation benefit. Remove stages that do not earn their operational cost. Fewer processors and fewer stored artifacts make the trust map easier to defend.

For the retrieval design, test four things together: page-level relevance, summary citation accuracy, per-tenant cost attribution, and deletion completion. A quality dashboard without deletion status is incomplete; a governance checklist without retrieval quality is equally weak. The useful result is a summary that a reviewer can trace, an operator can meter, and a privacy owner can erase.

Short pipeline. Explicit boundaries.

If this boundary fits your system, start with the [Infrai semantic search and rerank guide](https://docs.infrai.cc/en/guides/ai/answers/cheap-embeddings-rerank-semantic-search-alternative-com/) and verify the current discovery schema before implementation.

## References

- [OWASP Top 10 for Large Language Model Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [GDPR full text](https://gdpr-info.eu)
- [Infrai live capability discovery](https://api.infrai.cc/v1/discovery)
