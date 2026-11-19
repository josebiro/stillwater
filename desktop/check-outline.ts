import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { enhanceMeetingOutline, listEnhancements } from "./enhance.ts";
import { createMeeting } from "./vault.ts";

const vault = await mkdtemp(join(process.cwd(), ".vault-check-"));
const originalFetch = globalThis.fetch;
const manual = (id: string) => ({ manualId: id, text: "", segmentIds: [] });
const fact = (text: string, ...segmentIds: string[]) => ({ manualId: "", text, segmentIds });
const parent = (node, children = []) => ({ ...node, children });
let reply;
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(String(options?.body));
  const input = JSON.parse(request.messages[1].content.split("\n").slice(1).join("\n"));
  const review = input.candidates && Object.fromEntries(input.candidates.map(item=>[item.id,input.notes.every(n=>!n.text.includes("soundtrack"))]));
  return Response.json({done:true, message:{content:JSON.stringify(review ?? (request.format.properties.actions ? {actions:input.title==="Engineering discussion"?[{text:"Notify Sarah",owner:"Joseph",timing:"when the scanner ships",segmentIds:["S3"]}]:[]} : reply(input, request.format)))}});
};
try {
  const segments = ["Sarah: Staff-level coordination is needed earlier.", "Joseph: Junior work changed before too.", "Joseph: I will notify Sarah when the scanner ships."].map((text,i) => ({
    id: randomUUID(), source: "system" as const, startMs:i*1000, endMs:(i+1)*1000, text
  }));
  const bundle = await createMeeting(vault,"Engineering discussion","Staff skills are changing.",segments,[],["Sarah","Joseph"]);
  const outline = { sections:[{heading:"Engineering work",items:[parent(manual("M1"),[
    fact("Sarah sees coordination skills becoming important earlier.","S1"),fact("Joseph compares this shift to earlier changes in junior work.","S2")
  ])]}], actions:[{text:"Notify Sarah",owner:"Joseph",timing:"when the scanner ships",segmentIds:["S3"]}] };
  reply = input => {
    assert.equal(input.transcript[1].source,"system");
    assert.equal(input.transcript[1].startMs,1000);
    assert.deepEqual(input.participants,["Sarah","Joseph"]);
    return outline;
  };
  const result = await enhanceMeetingOutline(vault,bundle,"fixture","ollama");
  assert.match(result.draft.outline,/^- Staff skills are changing\.\n  - Sarah sees/m);
  assert.match(result.draft.outline,/\n  - Joseph compares/);
  assert.ok(result.draft.outline.includes("## Next Steps\n- **Notify Sarah** (Joseph) — when the scanner ships"));
  assert.deepEqual(result.draft.actions[0].segmentIds,[segments[2].id]);
  const soundtrack = await createMeeting(vault,"Test Note 09","Great soundtrack.",[segments[0]]);
  reply = () => ({sections:[{heading:"Soundtrack",items:[parent(manual("M1"),[fact("A great soundtrack, yes the music is great.","S1")])]}],actions:[]});
  assert.equal((await enhanceMeetingOutline(vault,soundtrack,"fixture","ollama")).draft.outline,"## Soundtrack\n- Great soundtrack.");
  const broadcast = await createMeeting(vault,"Broadcast","Watching the broadcast.",[
    {...segments[0],text:"The senator proposed moving the vote to Friday."},{...segments[1],text:"Around"}
  ]);
  const manualOnly = {sections:[{heading:"Background audio",items:[parent(manual("M1"))]}]};
  let quote = "The senator proposed moving the vote to Friday.";
  reply = (input,schema) => schema.properties.excerpts
    ? {excerpts:[{segmentId:"S1",quote,heading:"Senate discussion"}]} : manualOnly;
  const reviewed = await enhanceMeetingOutline(vault,broadcast,"fixture","ollama");
  assert.ok(reviewed.draft.outline.includes(segments[0].id), "A manual-only first pass must review the actual transcript for missed evidence");
  quote = "The Senator approved the bill.";
  const unsupported = await enhanceMeetingOutline(vault,broadcast,"fixture","ollama");
  assert.equal(unsupported.draft.generatedLines.length,0);
  assert.equal(unsupported.draft.transcriptSegmentCount,2);
  for (const item of [parent(fact("Unsupported","S99")), parent(manual("M1"),[manual("M1")])]) {
    reply=()=>({sections:[{heading:"Topic",items:[item]}],actions:[]});
    await assert.rejects(enhanceMeetingOutline(vault,bundle,"fixture","ollama"),/invalid outline/i);
  }
  assert.equal((await listEnhancements(bundle)).length,1);
  const longText = "Capture the release constraints. ".repeat(1100);
  const longMeeting = await createMeeting(vault,"Release planning",longText,[
    {...segments[0],text:"Incident triage. ".repeat(1700)},
    {...segments[1],text:"Stop the rollout at five percent."}
  ]);
  let sawIndexedEvidence = false;
  reply = (input,schema) => {
    if (schema.properties.topics) {
      const selected = input.transcript.filter(s=>s.text.includes("five percent"));
      return {topics:selected.length ? [{heading:"Rollout",segmentIds:selected.map(s=>s.id)}] : []};
    }
    if (schema.properties.M1) return {M1:"Rollout"};
    sawIndexedEvidence = input.transcript.at(-1).text.includes("five percent") && input.transcript.length > 1;
    // Exercise the omitted-note repair while preserving a long manual line verbatim.
    return {sections:[{heading:"Rollout",items:[parent(fact("Limit the rollout to five percent.","S2"))]}]};
  };
  const late = await enhanceMeetingOutline(vault,longMeeting,"fixture","ollama");
  assert.ok(sawIndexedEvidence);
  assert.ok(late.draft.outline.includes(segments[1].id));
  assert.ok(late.draft.outline.includes(longText));
  const multi = await createMeeting(vault,"Notebook",Array.from({length:30},(_,i)=>i+" "+"context ".repeat(120)).join("\n"),[]);
  reply = input => ({sections:[{heading:"Notebook",items:input.notes.map(n=>parent(manual(n.id)))}]});
  const notebook = await enhanceMeetingOutline(vault,multi,"fixture","ollama");
  assert.equal(notebook.draft.manualLines.length,30);
  assert.equal(notebook.draft.outline.match(/^## Notebook$/gm).length,1);
  const fragmented=await createMeeting(vault,"Planning","One\nTwo\nThree\nFour\nFive",[]);
  reply=input=>input.groups ? {groups:[{heading:"Planning",ids:input.groups.map(g=>g.id)}]} :
    {sections:input.notes.map(n=>({heading:n.text,items:[parent(manual(n.id))]}))};
  const regrouped=await enhanceMeetingOutline(vault,fragmented,"fixture","ollama");
  assert.equal(regrouped.draft.outline,"## Planning\n- One\n- Two\n- Three\n- Four\n- Five");
  console.log("Verified hierarchical evidence, attribution, restraint, action timing and invalid references.");
} finally { globalThis.fetch=originalFetch; await rm(vault,{recursive:true,force:true}); }
