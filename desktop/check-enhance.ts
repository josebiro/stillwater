import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enhanceMeeting, enhancementSections, listEnhancements } from "./enhance.ts";
import { createMeeting, openMeeting, saveTranscriptRevision } from "./vault.ts";
import { askMeeting, askVault } from "./meeting-qa.ts";

const vault = await mkdtemp(join(process.cwd(), ".vault-check-"));
try {
  const longNotes = "release notes ".repeat(1600);
  const longSpeech = "checklist discussion ".repeat(1400);
  const sections = enhancementSections(longNotes, [{ id: "S1", text: longSpeech }]);
  assert.ok(sections.length > 1);
  assert.ok(sections.every((section) => Buffer.byteLength(JSON.stringify(section)) < 20000));
  assert.equal(sections.map((section) => section.notes).join(""), longNotes);
  assert.equal(sections.flatMap((section) => section.transcript).map(({ text }) => text).join(""), longSpeech);
  const id = randomUUID();
  const bundle = await createMeeting(vault, "Release planning", "Release is next week.", [{
    id, source: "system", startMs: 0, endMs: 2000, text: "Alice will send the release checklist on Friday.",
  }]);
  const notes = await readFile(join(bundle, "notes.md"), "utf8");
  const mockStudio = process.argv.includes("--lm-studio-fixture");
  let fixtureRequests = 0;
  if (mockStudio) globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:1234/v1/chat/completions");
    const request = JSON.parse(String(options?.body));
    assert.equal(request.response_format.type, "json_schema");
    if (++fixtureRequests === 1) return new Response(null, { status: 503 });
    return Response.json({ model: request.model, choices: [{
      finish_reason: "stop", message: { content: JSON.stringify({
        summary: "Release planning.", actions: [{ text: "Send the release checklist.", segmentIds: ["S1"] }],
      }) },
    }] });
  };
  const provider = mockStudio || process.argv.includes("--lm-studio") ? "lm-studio" : "ollama";
  const started = performance.now();
  const model = provider === "lm-studio" ? process.env.STILLWATER_LM_STUDIO_MODEL ?? "openai/gpt-oss-20b"
    : process.env.STILLWATER_OLLAMA_MODEL ?? "qwen2.5:7b";
  const record = await enhanceMeeting(vault, bundle, model, provider);
  if (!mockStudio) console.log(`${provider} short fixture generation: ${((performance.now() - started) / 1000).toFixed(2)} s`);
  assert.equal(record.provider, provider);
  if (mockStudio) {
    assert.equal(fixtureRequests, 2);
    const validFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => Response.json({ choices: [
        { finish_reason: "stop", message: { content: "not a JSON draft" } },
      ] });
      await assert.rejects(enhanceMeeting(vault, bundle, record.model, provider), /could not be read as JSON/);
      globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
      await assert.rejects(enhanceMeeting(vault, bundle, record.model, provider), /Could not reach LM Studio/);
      assert.equal((await listEnhancements(bundle)).length, 1);
    } finally {
      globalThis.fetch = validFetch;
    }
  }
  assert.match(record.draft.summary, /release/i);
  assert.ok(record.draft.actions.some((action) => /checklist/i.test(action.text) && action.segmentIds.includes(id)));
  assert.equal(await readFile(join(bundle, "notes.md"), "utf8"), notes);
  assert.equal(JSON.parse(await readFile(join(bundle, `enhancement-${record.id}.json`), "utf8")).id, record.id);
  assert.equal((await listEnhancements(bundle))[0].id, record.id);
  assert.equal((await listEnhancements(bundle, await openMeeting(vault, bundle)))[0].stale, false);
  await appendFile(join(bundle, "notes.md"), "\nUpdated notes.");
  assert.equal((await listEnhancements(bundle, await openMeeting(vault, bundle)))[0].stale, true);
  await writeFile(join(bundle, "notes.md"), notes);
  const original = await openMeeting(vault, bundle);
  const revised = await saveTranscriptRevision(vault, bundle, original.revision, original.segments);
  const [olderDraft] = await listEnhancements(bundle, revised);
  assert.equal(olderDraft.stale, true);
  const cited = await openMeeting(vault, bundle, olderDraft.transcriptRevision);
  assert.equal(cited.revision, original.revision);
  assert.ok(cited.segments.some((segment) => segment.id === id));
  console.log(`${provider} saved an evidence-linked draft and preserved raw notes.`);
  if (process.argv.includes("--qa") && !mockStudio) {
    const answer = await askMeeting(vault, bundle, "Who will send the release checklist and when?", "qwen2.5:7b");
    assert.match(answer.text, /Alice/i);
    assert.match(answer.text, /Friday/i);
    assert.ok(answer.citations.some((citation) => citation.anchor === id));
    const across = await askVault(vault, "Who will send the release checklist and when?", "qwen2.5:7b");
    assert.match(across.text, /Alice/i);
    assert.match(across.text, /Friday/i);
    assert.ok(across.citations.some((citation) => citation.anchor === id && citation.bundle && citation.revision === revised.revision));
    console.log("Local Ollama answered the meeting question and cited the original segment.");
  }
  if (process.argv.includes("--long")) {
    const early = randomUUID();
    const late = randomUUID();
    const segments = [
      { id: early, source: "system" as const, startMs: 0, endMs: 1000, text: "Alice will send the release checklist on Friday." },
      { id: randomUUID(), source: "system" as const, startMs: 1000, endMs: 600000, text: longSpeech },
      { id: late, source: "system" as const, startMs: 600000, endMs: 603000, text: "Morgan will order the replacement projector on Monday." },
    ];
    const longBundle = await createMeeting(vault, "Long meeting fixture", "", segments);
    const started = performance.now();
    const result = await enhanceMeeting(vault, longBundle, process.env.STILLWATER_OLLAMA_MODEL ?? "qwen2.5:7b");
    console.log(`Ollama multi-section generation: ${((performance.now() - started) / 1000).toFixed(2)} s`);
    assert.ok(result.draft.actions.some((action) => /checklist/i.test(action.text) && action.segmentIds.includes(early)));
    assert.ok(result.draft.actions.some((action) => /projector/i.test(action.text) && action.segmentIds.includes(late)));
    console.log("Ollama retained actions and evidence from both ends of a multi-section meeting.");
  }
} finally {
  await rm(vault, { recursive: true, force: true });
}
