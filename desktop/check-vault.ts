import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { archiveMeeting, createMeeting, openMeeting, saveMeetingContexts, saveTranscriptRevision } from "./vault.ts";
import { readEnhancedNotes, saveEnhancedNotes } from "./enhanced-notes.ts";
import { refineMeeting } from "./import-meeting.ts";
import { listVaultContexts, resolveMeetingLink, searchVault } from "./vault-search.ts";

const vault = await mkdtemp(join(process.cwd(), ".vault-check-"));
try {
  const segment = {
    id: randomUUID(), source: "system" as const, startMs: 100, endMs: 950,
    text: "Send the notes on Friday.", engine: "moonshine", model: "quantized_26_11_02",
  };
  const bundle = await createMeeting(vault, "Roadmap: / planning?", "Confirm owners.", [segment]);
  const reopened = await openMeeting(vault, bundle);
  assert.equal(reopened.metadata.title, "Roadmap: / planning?");
  assert.match(reopened.notes, /Confirm owners/);
  assert.deepEqual(reopened.segments, [{ ...segment, revision: 1, final: true }]);
  await assert.rejects(refineMeeting(process.cwd(), vault, bundle, "en"), /no retained recording/);
  assert.equal((await openMeeting(vault, bundle)).metadata.transcriptRevision, 1);
  assert.ok((await readFile(join(bundle, "transcript.md"), "utf8")).includes(segment.id));
  await assert.rejects(openMeeting(vault, process.cwd()), /outside the vault/);
  const external = await mkdtemp(join(process.cwd(), ".vault-external-check-"));
  const linked = join(bundle, "..", "linked-meeting");
  try {
    await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
    try {
      await assert.rejects(openMeeting(vault, linked), /outside the vault/);
    } finally {
      await unlink(linked);
    }
  } finally {
    await rm(external, { recursive: true, force: true });
  }
  const first = await saveEnhancedNotes(bundle, "Initial enhanced notes.", null);
  await saveEnhancedNotes(bundle, "Updated enhanced notes.", first.revision);
  await assert.rejects(saveEnhancedNotes(bundle, "Stale editor content.", first.revision), /changed on disk/);
  assert.equal((await readEnhancedNotes(bundle)).text, "Updated enhanced notes.");
  assert.equal((await searchVault(vault, "send Friday"))[0].anchor, segment.id);
  assert.equal((await searchVault(vault, "updated enhanced")).length, 1);
  assert.deepEqual(await searchVault(vault, "initial enhanced"), []);
  await saveMeetingContexts(vault, bundle, "project: Atlas\ntopic: Procurement\nproject: atlas");
  assert.equal((await openMeeting(vault, bundle)).metadata.contexts.length, 2);
  assert.equal((await searchVault(vault, "Atlas Procurement")).length, 1);
  const archived = await archiveMeeting(vault, bundle, true);
  assert.equal(await resolveMeetingLink(vault, relative(vault, bundle)), archived);
  const archivedMeeting = await openMeeting(vault, archived);
  assert.equal(archivedMeeting.archived, true);
  assert.equal(archivedMeeting.metadata.meetingId, reopened.metadata.meetingId);
  const groups = await listVaultContexts(vault);
  assert.deepEqual(groups.map((group) => group.name), ["Atlas", "Procurement"]);
  assert.ok(groups.every((group) => group.meetings.length === 1 &&
    group.meetings[0].id === reopened.metadata.meetingId && group.meetings[0].archived));
  assert.equal((await searchVault(vault, "send Friday"))[0].anchor, segment.id);
  assert.equal(await archiveMeeting(vault, archived, false), bundle);
  const revision = await saveTranscriptRevision(vault, bundle, 1, [{ ...segment, text: "The checklist is ready." }]);
  assert.equal(revision.metadata.transcriptRevision, 2);
  assert.equal(revision.segments[0].text, "The checklist is ready.");
  assert.match(await readFile(join(bundle, "transcript.jsonl"), "utf8"), /Friday/);
  await assert.rejects(saveTranscriptRevision(vault, bundle, 1, [segment]), /changed while refinement/);
  const renamed = join(dirname(bundle), `${basename(bundle).slice(0, 10)}-renamed-meeting--${reopened.metadata.meetingId}`);
  await rename(bundle, renamed);
  assert.equal(await resolveMeetingLink(vault, relative(vault, bundle)), renamed);
  assert.equal((await openMeeting(vault, renamed)).metadata.meetingId, reopened.metadata.meetingId);
  const renamedGroups = await listVaultContexts(vault);
  assert.deepEqual(renamedGroups.map((group) => group.name), ["Atlas", "Procurement"]);
  assert.ok(renamedGroups.every((group) => group.meetings.length === 1 &&
    group.meetings[0].id === reopened.metadata.meetingId));
  const matches = await searchVault(vault, "updated enhanced");
  assert.equal(matches.length, 1);
  assert.equal(join(vault, matches[0].bundle), renamed);
  await rm(renamed, { recursive: true });
  assert.deepEqual(await searchVault(vault, "send Friday"), []);
  const fixtureAudio = join(vault, "fixture.wav");
  await writeFile(fixtureAudio, Buffer.alloc(0));
  const retained = await createMeeting(vault, "Retained recording", "", [segment], [
    { source: "microphone", path: fixtureAudio },
    { source: "system", path: fixtureAudio },
  ]);
  await unlink(join(retained, "audio", "system.wav"));
  await assert.rejects(refineMeeting(process.cwd(), vault, retained, "en"), /retained audio track is missing/);
  const afterFailure = await openMeeting(vault, retained);
  assert.equal(afterFailure.revision, 1);
  assert.deepEqual(afterFailure.segments, reopened.segments);
  assert.deepEqual(await readFile(join(retained, "audio", "microphone.wav")), Buffer.alloc(0));
  console.log("Meeting bundle reopened from canonical files.");
} finally {
  await rm(vault, { recursive: true, force: true });
}
