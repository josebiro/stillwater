(() => {
  const get = id => document.getElementById(id);
  const dialog = get("daily-dialog"), content = get("daily-content"), error = get("daily-error");
  const empty = () => ({meetings:[], labels:[], commitments:[], decisions:[], questions:[], folders:[]});
  let data = empty(), sequence = 0, saving = false;
  function element(tag, value) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function action(name, run) {
    const b = element("button",name);
    b.type = "button";
    b.addEventListener("click", async (event) => {
      try { await run(event); }
      catch (e) { (dialog.open ? error : status).textContent = e.message; }
    });
    return b;
  }
  function sheet(title) {
    get("daily-title").textContent = title;
    content.replaceChildren();
    error.textContent = "";
    if (!dialog.open) dialog.showModal();
  }
  get("daily-close").onclick = () => dialog.close();
  function field(parent,name,options,choicesOnly=false) {
    const row=element("label",name), input=element(choicesOnly?"select":"input");
    if (choicesOnly) for (const name of options) input.add(new Option(name,name));
    else {
      input.maxLength=500;
      if (options) {
        const list=element("datalist");
        list.id="choices-"+crypto.randomUUID();
        for(const value of options) list.append(new Option(value,value));
        input.setAttribute("list",list.id);
        row.append(list);
      }
    }
    row.append(input);
    parent.append(row);
    return input;
  }
  async function refresh() {
    const id=++sequence;
    const result=await window.stillwater.dailyJournal();
    if (id===sequence) { data=result ?? empty(); paint(); }
  }
  async function change(command) {
    if (saving) return false;
    saving=true;
    ++sequence;
    try {
      const result=await window.stillwater.dailyJournal(command);
      if (!result) return false;
      ++sequence;
      data=result;
      paint();
      return true;
    } finally { saving=false; }
  }
  const key = name => name.trim().normalize("NFC").toLowerCase();
  const draftTags = () => form.elements.filing.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const currentMeeting = () => data.meetings.find(m=>m.id===openedMeetingId);
  function editDraftTags(tags) {
    const value=tags.join("\n");
    if(value.length>2000) throw Error("This note has reached its label limit.");
    form.elements.filing.value=value;
    rememberDraft();
    paint();
  }
  function labelFields(parent,initial="project: ") {
    const split=initial.indexOf(":");
    const kind=field(parent,"Type",["project","person","area","topic","organization"],true);
    kind.value=initial.slice(0,split);
    const name=field(parent,"Label",[]);
    const options=parent.querySelector("datalist");
    function suggest() {
      options.replaceChildren(...data.labels.filter(t=>t.startsWith(kind.value+": ")).map(t=>new Option(t.slice(kind.value.length+2))));
    }
    suggest(); kind.onchange=suggest;
    name.value=initial.slice(split+1).trim(); name.maxLength=100;
    return () => {
      if (!name.value.trim()) throw Error("Enter a label name.");
      return kind.value+": "+name.value.trim();
    };
  }
  function addLabel(draft) {
    const id=openedMeetingId;
    sheet("Add label");
    const value=labelFields(content);
    content.append(action("Add label",async()=>{
      const tag=value();
      if(draft) {
        const tags=draftTags();
        if(!tags.some(t=>key(t)===key(tag))) editDraftTags([...tags,tag]);
      } else if(!await change({type:"attach",ids:[id],name:tag})) return;
      dialog.close();
    }));
  }
  function showLabel(tag) {
    if(window.openLabelPage){dialog.close();window.openLabelPage(tag);return;}
    sheet(tag);
    const matches=data.meetings.filter(m=>m.tags.some(t=>key(t)===key(tag)));
    for(const m of matches) content.append(action(m.title,()=>source(m)));
    if(!matches.length) content.append(element("p","No saved notes with this label yet."));
  }
  function chips(container,tags,draft) {
    container.replaceChildren();
    for(const tag of tags) {
      const chip=element("span"); chip.className="context-chip";
      const remove=action("×",async()=>{
        if(draft) editDraftTags(draftTags().filter(t=>key(t)!==key(tag)));
        else await change({type:"detach",ids:[openedMeetingId],name:tag});
      });
      remove.setAttribute("aria-label","Remove "+tag);
      chip.append(action(tag,()=>showLabel(tag)),remove); container.append(chip);
    }
    const add=action(tags.length?"+":"+ Add label",event=>{
      if(window.openLabelPicker) window.openLabelPicker(event.currentTarget, draft?{labels:true,draft:true}:{labels:true,ids:[openedMeetingId]});
      else addLabel(draft);
    });
    add.setAttribute("aria-haspopup","dialog");add.className="add-label";
    if(tags.length){add.title="Add or remove labels";add.setAttribute("aria-label","Add or remove labels");}
    container.append(add);
  }
  function manage() {
    sheet("Manage labels");
    const value=labelFields(content);
    content.append(action("Create label",async()=>{if(await change({type:"label",name:value()})) manage();}));
    for(const name of data.labels) {
      const row=element("div"); row.className="daily-row";
      row.append(action(name,()=>showLabel(name)),action("Rename",()=>{
        sheet("Rename "+name);
        const value=field(content,"New name"); value.value=name.slice(name.indexOf(":")+1).trim();
        const count=data.meetings.filter(m=>m.tags.some(t=>key(t)===key(name))).length;
        content.append(element("p",count+" affected notes"),action("Rename label",async()=>{
          if(await change({type:"rename",original:name,name:name.split(":")[0]+": "+value.value})) manage();
        }));
      }));content.append(row);
    }
  }
  function bulk() {
    sheet("Label multiple notes");
    const value=labelFields(content), selected=new Set(), count=element("p","0 selected");
    content.append(count);
    const buttons=["attach","detach"].map(type=>action(type==="attach"?"Add to selected":"Remove from selected",async()=>{
      if(await change({type,ids:[...selected],name:value()})) {
        dialog.close(); status.textContent="Updated labels on "+selected.size+" notes."; await findMeetings("",false,false);
      }
    }));
    buttons.forEach(b=>b.disabled=true);content.append(...buttons);
    for(const m of data.meetings) {
      const row=element("label"), checkbox=element("input");checkbox.type="checkbox";
      checkbox.onchange=()=>{if(checkbox.checked)selected.add(m.id);else selected.delete(m.id);
        count.textContent=selected.size+" selected";buttons.forEach(b=>b.disabled=!selected.size);};
      row.className="daily-check";row.append(checkbox,document.createTextNode(m.title));content.append(row);
    }
  }
  function quickQuestion() {
    sheet("Bring this up with…");
    const names=new Set(data.meetings.flatMap(m=>m.people));
    for(const tag of data.labels) if(tag.startsWith("person: ")) names.add(tag.slice(8));
    const person=field(content,"Person",[...names]), question=field(content,"Question");
    content.append(action("Save question",async()=>{
      if(await change({type:"question",person:person.value,text:question.value})) quickQuestion();
    }));
    for(const q of data.questions.filter(q=>!q.discussed)) content.append(element("p",q.person+" · "+q.text));
  }
  async function source(m, anchor="", revision) {
    const result=await window.stillwater.dailySource(m.id,anchor,revision);
    sheet(m.title);
    if(result.passage) content.append(element("blockquote",result.passage));
    else content.append(element("p",result.notes||"No written notes."));
    if(!startCapture.disabled) content.append(action("Open meeting note",async()=>{
      dialog.close(); await openSavedMeeting(m.path,anchor,"journal",revision);
    }));
  }
  function owed() {
    sheet("What do I owe?");
    const items=data.commitments.filter(c=>["confirmed","suggested"].includes(c.status));
    if(!items.length) content.append(element("p","Cited action items appear here after you enhance a meeting."));
    for(const c of items) {
      const m=data.meetings.find(m=>m.id===c.meeting);
      if(!m)continue;
      const row=element("section"); row.className="daily-row";
      row.append(element("strong",c.text),action(m.title,()=>source(m,c.anchor,c.revision)));
      if(c.status==="suggested") {
        const recipient=field(row,"Who is waiting?",m.people);
        row.append(action("This is mine",async()=>{if(await change({type:"commitment",id:c.id,status:"confirmed",recipient:recipient.value})) owed();}),
          action("Dismiss",async()=>{if(await change({type:"commitment",id:c.id,status:"dismissed"})) owed();}));
      } else row.append(element("span","For "+c.recipient),action("Mark done",async()=>{if(await change({type:"commitment",id:c.id,status:"done"})) owed();}));
      content.append(row);
    }
  }
  function decide() {
    const m=currentMeeting();if(!m)return;
    sheet("Record a decision");
    const projects=m.tags.filter(t=>t.startsWith("project: ")).map(t=>t.slice(9));
    if(!projects.length){content.append(element("p","Add a project label to this meeting first."),action("Add project label",()=>addLabel(false)));return;}
    const project=field(content,"Project",projects,true);
    const subject=field(content,"Decision topic",[...new Set(data.decisions.map(d=>d.subject))]);
    const outcome=field(content,"Decision"), reason=field(content,"Reason (optional)");
    const passage=field(content,"Source",["Meeting note"],true);
    passage.options[0].value="";
    for(const line of get("saved-transcript").children) passage.add(new Option(line.textContent.trim().slice(0,125),line.id.slice(8)));
    content.append(action("Save decision",async()=>{
      if(await change({type:"decision",meeting:m.id,project:project.value,subject:subject.value,text:outcome.value,
        reason:reason.value,anchor:passage.value,revision:displayedRevision})) historyView();
    }));
  }
  function historyView() {
    sheet("Where did we land?");
    if(!data.decisions.length) {content.append(element("p","Open a project meeting and choose Record a decision."));return;}
    const project=field(content,"Project",[...new Set(data.decisions.map(d=>d.project))],true);
    const list=element("div"); content.append(list);
    function draw() {
      list.replaceChildren();
      const seen=new Set();
      for(const d of data.decisions.slice().reverse().filter(d=>key(d.project)===key(project.value)).sort((a,b)=>b.date.localeCompare(a.date))) {
        const m=data.meetings.find(m=>m.id===d.meeting); if(!m)continue;
        const row=element("section");row.className="daily-row";
        row.append(element("small",seen.has(key(d.subject))?"Earlier decision":"Current decision"),element("strong",d.subject),element("p",d.text));
        if(d.reason)row.append(element("p",d.reason));
        row.append(action(m.title+" · "+new Date(d.date).toLocaleDateString(),()=>source(m,d.anchor,d.revision)));
        seen.add(key(d.subject));list.append(row);
      }
    }
    project.onchange=draw;draw();
  }
  function prep() {
    const section=get("meeting-prep"), body=section.querySelector("div");body.replaceChildren();
    const previous=data.meetings.filter(m=>m.event && m.event.id===form.dataset.calendarId &&
      m.event.start<form.dataset.calendarStart).sort((a,b)=>b.event.start.localeCompare(a.event.start))[0];
    const people=new Set([...form.elements.participants.value.split(","),...draftTags().filter(t=>t.startsWith("person: ")).map(t=>t.slice(8))].map(key));
    function carry(text) {
      const item=element("div");item.className="daily-row";const line="- "+text;
      const b=action("Add to agenda",()=>{notesEditor.value+=(notesEditor.value.trim()?"\n":"")+line;rememberDraft();b.disabled=true;});
      b.disabled=notesEditor.value.split("\n").includes(line);item.append(element("span",text),b);body.append(item);
    }
    if(previous){
      body.append(element("h3","From last time"),action(previous.title,()=>source(previous)));
      const last=data.decisions.filter(d=>d.meeting===previous.id).at(-1);
      if(last)carry(last.text);
      for(const c of data.commitments.filter(c=>c.meeting===previous.id && ["suggested","confirmed"].includes(c.status)))carry(c.text);
    }
    for(const q of data.questions.filter(q=>!q.discussed && people.has(key(q.person)))) {
      body.append(element("h3","Bring up with "+q.person));carry(q.text);
      body.append(action("Mark discussed",()=>change({type:"discussed",id:q.id})));
    }
    section.querySelector("summary").textContent=previous?"From last time":"Questions to bring up";
    section.hidden=!body.childElementCount;
  }
  function paint() {
    get("saved-labels").replaceChildren();
    chips(get("draft-labels"),draftTags(),true);
    const m=currentMeeting();
    if(m) {
      chips(get("saved-labels"),m.tags,false);
      if(document.activeElement!==contextEditor)contextEditor.value=m.tags.join("\n");
    }
    prep();
    const preview=get("owed-preview");
    preview.replaceChildren(...data.commitments.filter(c=>c.status==="confirmed").map(c=>action(c.text+" · "+c.recipient,owed)));
    document.dispatchEvent(new CustomEvent("journal-data",{detail:data}));
  }
  function mark() {
    if(get("mark-moment").disabled)return;
    const ms=Number(recordingElapsed.dataset.milliseconds)||0;
    const stamp=recordingElapsed.textContent;
    notesEditor.setRangeText("[Moment "+stamp+"](#moment-"+ms+") ",notesEditor.selectionEnd,notesEditor.selectionEnd,"end");
    rememberDraft();notesEditor.focus();
  }
  get("mark-moment").onclick=mark;
  document.addEventListener("keydown",e=>{
    if(workspaceView==="editor"&&!dialog.open&&e.ctrlKey&&e.shiftKey&&e.code==="KeyM"&&!get("mark-moment").disabled){e.preventDefault();mark();}
  });
  // Folders (folders.js) share this journal: its data, its writes and the label sheets.
  window.stillwaterJournal={get data(){return data;},change,refresh,showLabel,addLabel,manage,bulk,
    labelFields,sheet,action,element,draftTags,editDraftTags,close:()=>dialog.close(),error:message=>{error.textContent=message;}};
  get("manage-labels").onclick=manage;get("batch-labels").onclick=bulk;get("quick-question").onclick=quickQuestion;
  get("commitments").onclick=owed;get("sidebar-manage-labels").onclick=manage;get("decision-history").onclick=historyView;get("record-decision").onclick=decide;
  form.elements.participants.addEventListener("input",prep);form.elements.filing.addEventListener("input",paint);
  document.addEventListener("daily-question",quickQuestion);
  const update=()=>refresh().catch(e=>{status.textContent=e.message;});
  document.addEventListener("workspace-view",update);
  initialLibraryLoad.then(update);
})();
