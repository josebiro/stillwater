import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type HostedProvider = "openai" | "anthropic";
export const isHosted = (value: unknown): value is HostedProvider => value === "openai" || value === "anthropic";
const names = { openai: "OpenAI", anthropic: "Anthropic" };

async function keyFile(provider: HostedProvider) {
  if (!isHosted(provider)) throw Error("Choose a hosted provider.");
  const { app } = await import("electron");
  return join(app.getPath("userData"), provider + "-api-key.bin");
}

export async function readHostedKey(provider: HostedProvider) {
  const file = await keyFile(provider);
  const { safeStorage } = await import("electron");
  try {
    return (await safeStorage.decryptStringAsync(await readFile(file))).result;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw Error("Could not unlock the saved API key. Replace it in Settings.");
  }
}

export async function saveHostedKey(provider: HostedProvider, key: string | null) {
  const file = await keyFile(provider);
  if (key === null) return rm(file, { force:true });
  if (typeof key !== "string" || !/^[!-~]{1,2048}$/.test(key)) throw Error("Enter a valid API key.");
  const { safeStorage } = await import("electron");
  if (!(await safeStorage.isAsyncEncryptionAvailable()) || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
    throw Error("Secure key storage is unavailable on this device.");
  }
  const temp = file + "." + randomUUID();
  try {
    await writeFile(temp, await safeStorage.encryptStringAsync(key), {flag:"wx",mode:0o600});
    await rename(temp,file);
  } finally { await rm(temp,{force:true}); }
}

async function hostedFetch(provider: HostedProvider, key: string, path: string, signal: AbortSignal, body?: object) {
  if (!key) throw Error("Save your " + names[provider] + " API key in Settings.");
  const openai = provider === "openai";
  const origin = openai ? "https://api.openai.com" : "https://api.anthropic.com";
  const headers: Record<string,string> = openai ? {Authorization:"Bearer " + key} :
    {"x-api-key":key,"anthropic-version":"2023-06-01"};
  const result = await fetch(origin + path, {
    method: body ? "POST" : "GET", headers:{...headers,"content-type":"application/json"},
    body:body ? JSON.stringify(body) : undefined, redirect:"error", signal,
  }).catch(() => {
    signal.throwIfAborted();
    throw Error("Could not reach " + names[provider] + ".");
  });
  if (!result.ok) {
    const hint = result.status === 401 || result.status === 403 ? "Check the API key and model access." :
      result.status === 429 ? "Check billing or retry after the rate limit resets." :
      result.status === 400 || result.status === 404 ? "Choose a model that supports structured text responses." : "Try again later.";
    throw Error(names[provider] + " returned HTTP " + result.status + ". " + hint);
  }
  return result.json();
}

export async function listHostedModels(provider: HostedProvider, key: string) {
  const models = new Set<string>();
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(20000);
  let path = "/v1/models";
  while (true) {
    const page = await hostedFetch(provider,key,path,signal);
    if (!Array.isArray(page.data)) throw Error("Invalid model list from " + names[provider]);
    for (const model of page.data) {
      if (typeof model.id !== "string" || model.capabilities?.structured_outputs?.supported === false || model.lifecycle === "retired") continue;
      if (provider === "openai" && (!/^(gpt-|o\d|ft:|chatgpt-)/.test(model.id) ||
        /audio|realtime|transcrib|tts|image|search-preview/.test(model.id))) continue;
      models.add(model.id);
    }
    if (provider !== "anthropic" || !page.has_more) break;
    if (!page.last_id || cursors.has(page.last_id)) throw Error("Invalid model list cursor.");
    cursors.add(page.last_id);
    path = "/v1/models?after_id=" + encodeURIComponent(page.last_id);
  }
  return [...models].sort();
}

export async function hostedDraft(provider: HostedProvider, key: string, model: string, messages: {role:string;content:string}[], schema: object, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(120000);
  const requestSignal = signal ? AbortSignal.any([signal,timeout]) : timeout;
  let text: string;
  let usedModel: string;
  if (provider === "openai") {
    const result = await hostedFetch(provider,key,"/v1/responses",requestSignal,{
      model,input:messages,store:false,max_output_tokens:8192,
      text:{format:{type:"json_schema",name:"meeting_result",strict:true,schema}},
    });
    if (result.status !== "completed") throw Error("OpenAI did not complete the response.");
    text = result.output?.flatMap(item=>item.type === "message" ? item.content : [])
      .filter(block=>block.type==="output_text").map(block=>block.text).join("");
    usedModel = result.model;
  } else {
    const result = await hostedFetch(provider,key,"/v1/messages",requestSignal,{
      model,max_tokens:8192,system:messages.filter(m=>m.role==="system").map(m=>m.content).join("\n"),
      messages:messages.filter(m=>m.role!=="system"),output_config:{format:{type:"json_schema",schema}},
    });
    if (result.stop_reason !== "end_turn") throw Error("Anthropic did not complete the response.");
    text = result.content?.filter(block=>block.type==="text").map(block=>block.text).join("");
    usedModel = result.model;
  }
  try { return {draft:JSON.parse(text), model:usedModel || model}; }
  catch { throw Error(names[provider] + " did not return the requested structured response."); }
}
