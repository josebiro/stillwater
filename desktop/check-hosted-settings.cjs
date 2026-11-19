const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const {join} = require("node:path");
const {pathToFileURL} = require("node:url");
const {app, BrowserWindow} = require("electron");
const {randomUUID} = require("node:crypto");

(async () => {
  const root = process.cwd();
  const profile = await fs.mkdtemp(join(os.tmpdir(),"stillwater-hosted-check-"));
  app.setPath("userData",profile);
  app.setAppPath(root);
  const vault = join(profile,"vault");
  await fs.mkdir(vault);
  await fs.writeFile(join(profile,"vault-path.txt"),vault);
  const {createMeeting} = await import(pathToFileURL(join(root,"desktop/vault.ts")));
  await createMeeting(vault,"Release","Release plan",[{id:randomUUID(),source:"system",startMs:0,endMs:1000,text:"Release ships Friday."}]);
  const calls = [];
  const reviews = new Set();
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url);
    const openai = endpoint.hostname === "api.openai.com";
    assert.ok(openai || endpoint.hostname === "api.anthropic.com");
    const provider = openai ? "openai" : "anthropic";
    assert.equal(options.headers[openai ? "Authorization" : "x-api-key"],(openai?"Bearer ":"")+provider+"-fixture-secret");
    assert.equal(options.redirect,"error");
    if (endpoint.pathname === "/v1/models") {
      if (openai) return Response.json({data:[{id:"gpt-test"},{id:"gpt-image-test"}]});
      return Response.json(endpoint.search ? {data:[{id:"claude-fable-test"}]} :
        {data:[{id:"claude-sonnet-test"}],has_more:true,last_id:"claude-sonnet-test"});
    }
    const body = JSON.parse(options.body);
    const schema = openai ? body.text.format.schema : body.output_config.format.schema;
    assert.equal(endpoint.pathname,openai ? "/v1/responses" : "/v1/messages");
    assert.equal(body.model, openai ? "gpt-test" : "claude-fable-test");
    if (openai) assert.equal(body.store,false);
    else assert.ok(body.system && body.messages.every(m=>m.role!=="system"));
    let result;
    if (schema.properties.actions) result = {actions:[]};
    else if (schema.properties.B1) result = {B1:true};
    else if (schema.properties.excerpts) {
      const first = !reviews.has(provider);
      reviews.add(provider);
      result = {excerpts:first ? [{segmentId:"S1",quote:"Release ships Friday.",heading:"Delivery"}] : []};
    }
    else if (schema.properties.sections) result = {sections:[{heading:"Delivery",items:[{manualId:"M1",text:"",segmentIds:[],children:[]}]}]};
    else {
      const input = JSON.parse((body.input ?? body.messages).at(-1).content);
      result = {answer:"Friday.",refs:[input.evidence[0].ref]};
    }
    calls.push(provider);
    const text = JSON.stringify(result);
    return Response.json(openai ? {status:"completed",output:[{type:"message",content:[{type:"output_text",text}]}]} :
      {stop_reason:"end_turn",content:[{type:"text",text}]});
  };
  await import(pathToFileURL(join(root,"desktop/main.ts")));
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  const js = code => win.webContents.executeJavaScript(code);
  for (const provider of ["openai","anthropic"]) {
    const model = provider === "openai" ? "gpt-test" : "claude-fable-test";
    await js(`(async()=>{
      await initialLibraryLoad;
      const one = s=>document.querySelector(s);
      const wait=async f=>{for(let i=0;i<160;i++){if(f())return;await new Promise(r=>setTimeout(r,25));}throw Error("Timed out: "+one("#model-discovery-status").textContent+" / "+one("#provider-key-status").textContent);};
      one("#speech-settings").open=true;
      one("#draft-provider").value=${JSON.stringify(provider)};
      one("#draft-provider").dispatchEvent(new Event("change"));
      await wait(()=>one("#provider-key-status").textContent.includes("Add an API key"));
      one("#provider-key").value=${JSON.stringify(provider+"-fixture-secret")};
      one("#save-provider-key").click();
      await wait(()=>!one("#remove-provider-key").hidden && !one("#discover-models").disabled);
      if(one("#provider-key").value)throw Error("Key field still populated");
      one("#discover-models").click();
      await wait(()=>!one("#available-model-label").hidden);
      one("#available-model").value=${JSON.stringify(model)};
      one("#available-model").dispatchEvent(new Event("change"));
      if(one("#draft-model").value!==${JSON.stringify(model)})throw Error("Model selection failed");
      one("#speech-settings").open=false;
      one("#go-home").click();
      await wait(()=>one(".dated-meeting"));
      one(".dated-meeting").click();
      await wait(()=>!one("#saved-meeting").hidden);
      one("#enhance-meeting").click();
      await wait(()=>!one("#enhance-meeting").disabled);
      if(!one("#meeting-note-citations").textContent.includes("Delivery"))throw Error("Enhancement failed: "+one("main > [role=status]").textContent);
      const before = one("#enhanced-editor").value;
      if(!before.includes("Release ships Friday.") || !one("#meeting-note-citations .note-citation"))throw Error("Missing transcript addition");
      one("#enhance-meeting").click();
      await wait(()=>!one("#enhance-meeting").disabled);
      if(one("#enhanced-editor").value!==before || !one("main > [role=status]").textContent.includes("Your notes were kept"))throw Error("A manual-only regeneration replaced the cited note");
      for(const form of ["meeting","vault"]){
        if(form==="vault")one("#go-home").click();
        const input=one("#"+form+"-question");
        input.elements.question.value="Release";
        input.requestSubmit();
        await wait(()=>one("#"+form+"-answer").textContent.includes("Friday."));
      }
    })()`);
    const cipher = await fs.readFile(join(profile,provider+"-api-key.bin"));
    assert.ok(!cipher.includes(Buffer.from(provider+"-fixture-secret")));
    assert.ok(calls.filter(p=>p===provider).length>=4);
    await win.loadFile(join(root,"desktop/index.html"));
    assert.equal(await js('document.querySelector("#draft-model").value'),model);
  }
  await js(`(async()=>{document.querySelector("#remove-provider-key").click();
    for(let i=0;i<100 && !document.querySelector("#provider-key-status").textContent.includes("removed");i++)await new Promise(r=>setTimeout(r,25));})()`);
  await assert.rejects(fs.stat(join(profile,"anthropic-api-key.bin")),{code:"ENOENT"});
  await fs.access(join(profile,"openai-api-key.bin"));
  const {listHostedModels,hostedDraft} = await import(pathToFileURL(join(root,"desktop/hosted-models.ts")));
  await assert.rejects(listHostedModels("anthropic",""),/Save your Anthropic API key/);
  globalThis.fetch = async () => Response.json({error:"fixture-secret-must-not-appear"},{status:401});
  await assert.rejects(listHostedModels("openai","openai-fixture-secret"), error =>
    error.message.includes("401") && !error.message.includes("fixture-secret"));
  globalThis.fetch = async () => Response.json({stop_reason:"max_tokens",content:[]});
  await assert.rejects(hostedDraft("anthropic","fixture","model",[],{}),/did not complete/);
  console.log("Hosted settings, encrypted keys, discovery, persistence, enhancement, meeting questions and vault questions passed for both providers.");
  app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
