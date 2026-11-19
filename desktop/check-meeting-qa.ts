import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMeeting } from "./vault.ts";
import { saveEnhancedNotes } from "./enhanced-notes.ts";
import { askMeeting } from "./meeting-qa.ts";

const vault = await mkdtemp(join(process.cwd(), ".vault-check-"));
const originalFetch = globalThis.fetch;
try {
  const bundle = await createMeeting(vault, "Budget", "Budget pending", []);
  await saveEnhancedNotes(bundle, "Approved budget is $750", null);
  globalThis.fetch = async (_url, options) => {
    const { messages } = JSON.parse(String(options?.body));
    const source = JSON.parse(messages[1].content).evidence.find(e => e.text.includes("$750"));
    return Response.json({ done: true, message: { content: JSON.stringify(
      { answer: source ? "$750" : "Unknown", refs: source ? [source.ref] : [] }) } });
  };
  const answer = await askMeeting(vault, bundle, "What is our approved budget?", "fixture");
  assert.equal(answer.text, "$750");
  assert.equal(answer.citations[0].text, "Approved budget is $750");
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/v1\/chat\/completions$/);
    return Response.json({ choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify({ answer: "$750", refs: ["notes"] }) } }] });
  };
  assert.equal((await askMeeting(vault, bundle, "Budget?", "fixture", "lm-studio")).text, "$750");
  console.log("Meeting questions cite the current saved notes.");
} finally {
  globalThis.fetch = originalFetch;
  await rm(vault, { recursive: true, force: true });
}
