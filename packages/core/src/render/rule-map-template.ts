// Inlined Rule Map explorer template (zero runtime deps). The build (tsc) does not
// copy non-.ts assets, so the HTML shell ships as a string constant compiled with
// the code. It is a plain template literal — edit the HTML/CSS/JS in place here;
// keep it a literal (escape only a backtick as \` and a literal ${ as \${), since
// rule-map.ts injects the data by string-replacing the `/*__DATA__*/ null` token.
export const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Directive — Rule Map</title>
<style>
  :root{
    --bg:#0f1115; --panel:#171a21; --panel2:#1d222b; --line:#2a303b;
    --ink:#e7ebf0; --dim:#96a0ad; --dim2:#6b7482; --accent:#6ea8fe; --accent2:#8be0c0;
    --must:#ff6b6b; --mustnot:#c0392b; --should:#f0b429; --shouldnot:#9a7b12; --may:#7f8a99;
    --radius:12px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:var(--bg);color:var(--ink);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  a{color:var(--accent);text-decoration:none}
  .wrap{max-width:1120px;margin:0 auto;padding:22px 24px 80px}
  header.top{display:flex;align-items:center;gap:18px;flex-wrap:wrap;
    border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:20px}
  .brand{font-size:20px;font-weight:700;letter-spacing:.2px}
  .brand small{display:block;font-size:12px;color:var(--dim);font-weight:400;margin-top:2px}
  nav.spines{display:flex;gap:6px;margin-left:auto}
  nav.spines button{background:var(--panel);color:var(--dim);border:1px solid var(--line);
    padding:7px 14px;border-radius:999px;cursor:pointer;font-size:13px}
  nav.spines button.active{background:var(--accent);color:#0b0d10;border-color:var(--accent);font-weight:600}
  .search{width:100%;margin:0 0 18px}
  .search input{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--ink);
    padding:11px 14px;border-radius:10px;font-size:14px}
  .search input::placeholder{color:var(--dim2)}
  .crumbs{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dim);font-size:13px;margin-bottom:16px}
  .crumbs a{cursor:pointer}
  .crumbs .sep{color:var(--dim2)}
  .crumbs .here{color:var(--ink)}
  .lead{color:var(--dim);margin:-4px 0 20px;max-width:760px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
    padding:15px 16px;cursor:pointer;transition:.12s;display:flex;flex-direction:column;gap:7px;min-height:96px}
  .card:hover{border-color:var(--accent);background:var(--panel2);transform:translateY(-1px)}
  .card .name{font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px}
  .card .name .ic{color:var(--dim2);font-size:13px}
  .card .desc{color:var(--dim);font-size:13px;line-height:1.45}
  .card .meta{margin-top:auto;display:flex;align-items:center;gap:10px;color:var(--dim2);font-size:12px}
  .rows{display:flex;flex-direction:column;gap:8px}
  .row{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;
    cursor:pointer;transition:.12s;display:flex;align-items:center;gap:12px}
  .row:hover{border-color:var(--accent);background:var(--panel2)}
  .row .rname{font-weight:600;min-width:0}
  .row .rname .sub{font-weight:400;color:var(--dim);font-size:13px;display:block;margin-top:2px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .rt{margin-left:auto;display:flex;gap:5px;flex-shrink:0}
  .row .chev{color:var(--dim2);flex-shrink:0}
  .tier{font-size:11px;padding:2px 7px;border-radius:999px;font-weight:600;white-space:nowrap;
    color:#0b0d10;font-family:ui-monospace,monospace}
  .t-MUST{background:var(--must)} .t-MUST-NOT{background:var(--mustnot);color:#fff}
  .t-SHOULD{background:var(--should)} .t-SHOULD-NOT{background:var(--shouldnot);color:#fff}
  .t-MAY{background:var(--may);color:#fff}
  .bar{display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--panel2);flex:1;max-width:120px}
  .bar span{display:block;height:100%}
  .detail{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:22px 24px}
  .detail h2{margin:0 0 4px;font-size:22px}
  .detail .kind{color:var(--dim2);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
  .detail .summary{color:var(--dim);margin:12px 0 18px;max-width:720px}
  .sectionlist{display:flex;flex-wrap:wrap;gap:7px;margin:6px 0 4px}
  .sectionlist .s{background:var(--panel2);border:1px solid var(--line);border-radius:7px;
    padding:5px 10px;font-size:12.5px;color:var(--ink)}
  .srcbox{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}
  .srcbox .path{font-size:12.5px;color:var(--dim);word-break:break-all;margin-bottom:10px}
  .btns{display:flex;gap:8px;flex-wrap:wrap}
  button.act{background:var(--accent);color:#0b0d10;border:none;padding:8px 14px;border-radius:8px;
    cursor:pointer;font-size:13px;font-weight:600}
  button.act.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
  button.act:hover{filter:brightness(1.08)}
  h3.grouphdr{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim2);margin:26px 0 10px}
  .legend{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin:2px 0 18px}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--panel2);
    border:1px solid var(--line);color:var(--ink);padding:11px 18px;border-radius:10px;font-size:13px;
    opacity:0;transition:.2s;pointer-events:none;box-shadow:0 8px 30px rgba(0,0,0,.4);z-index:50}
  .toast.show{opacity:1}
  .toast.err{border-color:var(--must)}
  .flow{display:flex;flex-wrap:wrap;align-items:stretch;gap:0}
  .flow .node{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 14px;text-align:center;min-width:110px}
  .flow .node .st{font-weight:600}
  .flow .node .via{font-size:11px;color:var(--dim2);margin-top:3px;font-family:ui-monospace,monospace}
  .flow .arw{align-self:center;color:var(--dim2);padding:0 8px;font-size:18px}
  .ladder{display:flex;flex-direction:column;gap:8px;margin:6px 0 20px}
  .ladder .lv{display:flex;gap:12px;align-items:baseline;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:11px 14px}
  .ladder .lv b{min-width:190px}
  .ladder .lv .d{color:var(--dim);font-size:13px}
  .pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dim);
    background:var(--panel2);border:1px solid var(--line);padding:4px 9px;border-radius:999px;margin:0 6px 6px 0}
  .muted{color:var(--dim2);font-size:12px}
  .empty{color:var(--dim);padding:30px;text-align:center}
  .foot{margin-top:34px;color:var(--dim2);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
  /* source viewer */
  .src{margin-top:16px;background:#0b0d12;border:1px solid var(--line);border-radius:10px;padding:16px 18px;
    max-height:60vh;overflow:auto}
  .src h1,.src h2,.src h3{color:var(--ink);margin:14px 0 6px;line-height:1.3}
  .src h1{font-size:19px} .src h2{font-size:16px} .src h3{font-size:14px}
  .src p{margin:8px 0;color:#c7cfda}
  .src ul{margin:8px 0;padding-left:22px;color:#c7cfda}
  .src li{margin:3px 0}
  .src code{background:#161b24;border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:12.5px;color:var(--accent2)}
  .src pre{background:#161b24;border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto}
  .src pre code{background:none;border:none;padding:0;color:#c7cfda}
  .src blockquote{border-left:3px solid var(--line);margin:8px 0;padding:2px 12px;color:var(--dim)}
  .src .trunc{color:var(--dim2);font-size:12px;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">Directive &mdash; Rule Map<small id="sub">maintainer map</small></div>
    <nav class="spines">
      <button data-spine="rules">Rules</button>
      <button data-spine="tasks">Tasks</button>
      <button data-spine="lifecycle">Lifecycle</button>
    </nav>
  </header>

  <div class="search"><input id="q" placeholder="Search groupings, rules, tasks…  (Esc to clear)"></div>
  <div class="crumbs" id="crumbs"></div>
  <div id="view"></div>
  <div class="foot" id="foot"></div>
</div>
<div class="toast" id="toast"></div>

<script>window.DIRECTIVE_DATA = /*__DATA__*/ null;</script>
<script>
let DATA=window.DIRECTIVE_DATA, spine="rules", stack=[];
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;};
const tierClass=t=>"t-"+t.replace(/\\s|_/g,"-");
const TIER_ORDER=["MUST","MUST NOT","SHOULD","SHOULD NOT","MAY"];
const TIER_COLOR={"MUST":"var(--must)","MUST NOT":"var(--mustnot)","SHOULD":"var(--should)","SHOULD NOT":"var(--shouldnot)","MAY":"var(--may)"};
const MARK2TIER={"!":"MUST","⊗":"MUST NOT","~":"SHOULD","≉":"SHOULD NOT","?":"MAY"};

function toast(msg,err){const t=document.getElementById('toast');t.textContent=msg;
  t.className='toast show'+(err?' err':'');setTimeout(()=>t.className='toast',1800);}
function copyPath(p){
  const ok=()=>toast("Path copied");
  const fail=()=>toast("Copy failed",true);
  const fallback=()=>{
    try{
      const ta=document.createElement("textarea");
      ta.value=p;ta.setAttribute("readonly","");
      ta.style.position="fixed";ta.style.left="-9999px";
      document.body.appendChild(ta);ta.select();
      const done=document.execCommand("copy");
      document.body.removeChild(ta);
      done?ok():fail();
    }catch(_){fail();}
  };
  if(navigator.clipboard&&typeof navigator.clipboard.writeText==="function"){
    navigator.clipboard.writeText(p).then(ok,fallback);
  }else fallback();
}

/* tiny zero-dependency markdown renderer (headings, lists, code, quote, inline) */
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function inlineMd(s){
  s=esc(s);
  s=s.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  s=s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  s=s.replace(/(^|[^*])\\*([^*]+)\\*/g,'$1<em>$2</em>');
  s=s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,function(_,t,u){return /^(?:https?:|[/#.])/i.test(u)?'<a href="'+u+'">'+t+'</a>':t;});
  return s;
}
function mdToHtml(md){
  const lines=(md||"").split("\\n");
  let out=[], i=0, inCode=false, code=[], list=false;
  const closeList=()=>{if(list){out.push("</ul>");list=false;}};
  while(i<lines.length){
    let ln=lines[i];
    if(/^\`\`\`/.test(ln)){
      if(!inCode){inCode=true;code=[];}
      else{inCode=false;out.push("<pre><code>"+esc(code.join("\\n"))+"</code></pre>");}
      i++;continue;
    }
    if(inCode){code.push(ln);i++;continue;}
    let m;
    if((m=ln.match(/^(#{1,3})\\s+(.*)$/))){closeList();out.push(\`<h\${m[1].length}>\`+inlineMd(m[2])+\`</h\${m[1].length}>\`);}
    else if(/^\\s*[-*]\\s+/.test(ln)){if(!list){out.push("<ul>");list=true;}out.push("<li>"+inlineMd(ln.replace(/^\\s*[-*]\\s+/,""))+"</li>");}
    else if(/^\\s*>\\s?/.test(ln)){closeList();out.push("<blockquote>"+inlineMd(ln.replace(/^\\s*>\\s?/,""))+"</blockquote>");}
    else if(ln.trim()===""){closeList();}
    else{closeList();out.push("<p>"+inlineMd(ln)+"</p>");}
    i++;
  }
  closeList();
  if(inCode)out.push("<pre><code>"+esc(code.join("\\n"))+"</code></pre>");
  return out.join("\\n");
}

function markerBar(markers){
  const total=Object.values(markers||{}).reduce((a,b)=>a+b,0);
  const bar=el('div','bar'); if(!total) return bar;
  TIER_ORDER.forEach(t=>{const v=markers[t]||0;if(!v)return;
    const s=el('span');s.style.width=(v/total*100)+'%';s.style.background=TIER_COLOR[t];s.title=t+": "+v;bar.appendChild(s);});
  return bar;
}
function markersFromMarks(m){const o={};for(const k in (m||{})){const t=MARK2TIER[k];if(t)o[t]=(o[t]||0)+m[k];}return o;}
function totalMarks(m){return Object.values(m||{}).reduce((a,b)=>a+b,0);}

function go(node){stack.push(node);render();}
function reset(s){spine=s;stack=[];render();}
function crumbTo(i){stack=stack.slice(0,i);render();}
function setSpine(s){document.querySelectorAll('nav.spines button').forEach(b=>b.classList.toggle('active',b.dataset.spine===s));}

function render(){
  setSpine(spine);
  const view=document.getElementById('view');view.innerHTML='';
  renderCrumbs();
  if(document.getElementById('q').value.trim()){renderSearch(view);return;}
  if(stack.length===0){ ({rules:overviewRules,tasks:overviewTasks,lifecycle:renderLifecycle})[spine](view); return; }
  stack[stack.length-1].render(view);
}
function renderCrumbs(){
  const c=document.getElementById('crumbs');c.innerHTML='';
  const root=el('a','',spine[0].toUpperCase()+spine.slice(1));root.onclick=()=>{stack=[];render();};c.appendChild(root);
  stack.forEach((n,i)=>{c.appendChild(el('span','sep','›'));
    if(i<stack.length-1){const a=el('a','',n.label);a.onclick=()=>crumbTo(i+1);c.appendChild(a);}
    else c.appendChild(el('span','here',n.label));});
}
function intro(t){return el('div','lead',t);}
function ghdr(t){return el('h3','grouphdr',t);}
function pathBar(p){const box=el('div','srcbox');box.appendChild(el('div','path',p));
  const b=el('button','act ghost','Copy path');b.onclick=e=>{e.stopPropagation();copyPath(p);};
  const btns=el('div','btns');btns.appendChild(b);box.appendChild(btns);return box;}

function overviewRules(view){
  document.getElementById('foot').textContent=
    \`\${DATA.groupings.length} rule groupings · \${DATA.groupings.reduce((a,g)=>a+g.doc_count,0)} docs · derived from content/\`;
  view.appendChild(intro("Major rule groupings — lazy-loaded bodies of guidance the agent pulls in only when the work needs it. Click to drill in."));
  const grid=el('div','grid');
  DATA.groupings.forEach(g=>{
    const card=el('div','card');
    card.appendChild(el('div','name',g.name));
    card.appendChild(el('div','desc',g.purpose||''));
    const meta=el('div','meta');meta.appendChild(el('span','',g.doc_count+' docs'));meta.appendChild(markerBar(g.markers));card.appendChild(meta);
    card.onclick=()=>go({label:g.name,render:v=>groupView(v,g)});
    grid.appendChild(card);
  });
  view.appendChild(grid);
}
function groupView(view,g){
  view.appendChild(intro(g.purpose||''));
  const files=g.items.filter(i=>i.kind==='file'), dirs=g.items.filter(i=>i.kind==='dir');
  if(files.length){view.appendChild(ghdr("Documents"));view.appendChild(rowsOf(files));}
  if(dirs.length){view.appendChild(ghdr("Topics"));
    const grid=el('div','grid');
    dirs.forEach(d=>{const card=el('div','card');card.appendChild(el('div','name',d.title||d.name));
      if(d.summary)card.appendChild(el('div','desc',d.summary));
      const meta=el('div','meta');meta.appendChild(el('span','',d.count+' files'));card.appendChild(meta);
      card.onclick=()=>go({label:d.name,render:v=>dirView(v,d)});grid.appendChild(card);});
    view.appendChild(grid);
  }
}
function dirView(view,d){
  view.appendChild(intro(d.summary||''));
  if(d.readme){view.appendChild(ghdr("Overview"));view.appendChild(rowsOf([d.readme]));}
  view.appendChild(ghdr("Files"));view.appendChild(rowsOf(d.files));
}
function rowsOf(files){
  const box=el('div','rows');
  files.forEach(f=>{
    const row=el('div','row');
    const nm=el('div','rname');nm.appendChild(document.createTextNode(f.title||f.name));
    if(f.summary)nm.appendChild(el('span','sub',f.summary));
    row.appendChild(nm);
    const rt=el('div','rt');const mk=markersFromMarks(f.markers);
    TIER_ORDER.forEach(t=>{if(mk[t]){const b=el('span','tier '+tierClass(t),mk[t]+" "+t.replace(" NOT","̸"));b.title=mk[t]+" "+t;rt.appendChild(b);}});
    row.appendChild(rt);row.appendChild(el('span','chev','›'));
    row.onclick=()=>go({label:f.name,render:v=>docDetail(v,f)});
    box.appendChild(row);
  });
  return box;
}
function docDetail(view,f){
  const d=el('div','detail');
  d.appendChild(el('div','kind',(f.generated?'generated view · ':'')+(f.lines?f.lines+' lines':'document')));
  d.appendChild(el('h2',null,f.title||f.name));
  if(f.summary)d.appendChild(el('div','summary',f.summary));
  const mk=markersFromMarks(f.markers);
  if(totalMarks(f.markers)){const p=el('div');p.style.margin='0 0 14px';
    TIER_ORDER.forEach(t=>{if(mk[t]){const b=el('span','tier '+tierClass(t));b.textContent=mk[t]+" "+t;b.style.marginRight='6px';p.appendChild(b);}});
    d.appendChild(p);}
  if(f.sections&&f.sections.length){d.appendChild(el('div','muted','Sections'));
    const sl=el('div','sectionlist');f.sections.forEach(s=>sl.appendChild(el('div','s',s)));d.appendChild(sl);}
  if(f.generated)d.appendChild(Object.assign(el('div','muted'),{textContent:'⚠ Auto-generated from a pack — edit the source pack, not this file.',style:'margin-top:12px'}));

  const box=el('div','srcbox');
  box.appendChild(el('div','path',f.path));
  const btns=el('div','btns');
  const srcPane=el('div','src');srcPane.style.display='none';
  let shown=false;
  const view_=el('button','act','View source');
  view_.onclick=e=>{e.stopPropagation();shown=!shown;
    if(shown&&!srcPane.dataset.rendered){srcPane.innerHTML=mdToHtml(f.body||'(source not captured)');
      if(f.truncated)srcPane.appendChild(Object.assign(el('div','trunc'),{textContent:'… truncated (large file); open the file directly for the rest.'}));
      srcPane.dataset.rendered='1';}
    srcPane.style.display=shown?'block':'none';view_.textContent=shown?'Hide source':'View source';};
  const copy=el('button','act ghost','Copy path');copy.onclick=e=>{e.stopPropagation();copyPath(f.path);};
  btns.appendChild(view_);btns.appendChild(copy);box.appendChild(btns);box.appendChild(srcPane);
  d.appendChild(box);
  view.appendChild(d);
}

function overviewTasks(view){
  document.getElementById('foot').textContent=
    \`\${DATA.tasks.length} task namespaces · \${DATA.tasks.reduce((a,t)=>a+t.task_count,0)} tasks · run: task <namespace>:<name>\`;
  view.appendChild(intro("The executable layer. Rules are enforced by Taskfile targets — deterministic gates the agent and CI run. Each card is a namespace; drill in for its commands."));
  const grid=el('div','grid');
  DATA.tasks.forEach(t=>{const card=el('div','card');
    const nm=el('div','name');nm.appendChild(document.createTextNode(t.namespace));
    if(t.unlisted)nm.appendChild(Object.assign(el('span','ic'),{textContent:'unlisted'}));
    card.appendChild(nm);card.appendChild(el('div','desc',t.purpose||''));
    const meta=el('div','meta');meta.appendChild(el('span','',t.task_count+' tasks'));card.appendChild(meta);
    card.onclick=()=>go({label:t.namespace,render:v=>taskDetail(v,t)});grid.appendChild(card);});
  view.appendChild(grid);
}
function taskDetail(view,t){
  view.appendChild(intro(t.purpose||''));
  view.appendChild(ghdr("Commands"));
  const box=el('div','rows');
  t.tasks.forEach(tk=>{const row=el('div','row');row.style.cursor='default';
    const nm=el('div','rname');nm.appendChild(Object.assign(el('code'),{textContent:'task '+t.namespace+':'+tk.name}));
    if(tk.desc)nm.appendChild(el('span','sub',tk.desc));row.appendChild(nm);box.appendChild(row);});
  view.appendChild(box);
  view.appendChild(pathBar(t.path));
}
function renderLifecycle(view){
  const L=DATA.lifecycle;
  document.getElementById('foot').textContent="Lifecycle & gates · source: "+L.source;
  view.appendChild(intro(L.summary));
  view.appendChild(ghdr("Rule strength — prefer enforceable over remembered"));
  const lad=el('div','ladder');
  L.rule_strength.forEach((r,i)=>{const lv=el('div','lv');lv.appendChild(Object.assign(el('b'),{textContent:(i+1)+". "+r.level}));lv.appendChild(el('span','d',r.detail));lad.appendChild(lv);});
  view.appendChild(lad);
  view.appendChild(ghdr("Scope lifecycle"));
  const flow=el('div','flow');
  L.scope_states.forEach((s,i)=>{if(i)flow.appendChild(el('div','arw','→'));
    const n=el('div','node');n.appendChild(el('div','st',s.state));n.appendChild(el('div','via',s.via));flow.appendChild(n);});
  view.appendChild(flow);
  view.appendChild(ghdr("vBRIEF — the durable state"));
  const box=el('div','rows');
  L.vbrief_files.forEach(v=>{const row=el('div','row');row.style.cursor='default';
    const nm=el('div','rname');nm.appendChild(Object.assign(el('code'),{textContent:v.file}));nm.appendChild(el('span','sub',v.role));row.appendChild(nm);box.appendChild(row);});
  view.appendChild(box);
  view.appendChild(ghdr("Quality gates"));
  const g=el('div');g.style.marginBottom='14px';
  L.gates.forEach(x=>{const p=el('span','pill');p.appendChild(Object.assign(el('code'),{textContent:x}));g.appendChild(p);});
  view.appendChild(g);
  view.appendChild(ghdr("Key docs"));
  const kd=el('div','rows');
  L.key_docs.forEach(doc=>{const row=el('div','row');row.style.cursor='default';
    const nm=el('div','rname');nm.appendChild(document.createTextNode(doc.title));nm.appendChild(el('span','sub',doc.path));row.appendChild(nm);
    const b=el('button','act ghost','Copy path');b.onclick=e=>{e.stopPropagation();copyPath(doc.path);};
    const rt=el('div','rt');rt.appendChild(b);row.appendChild(rt);kd.appendChild(row);});
  view.appendChild(kd);
}
function renderSearch(view){
  const q=document.getElementById('q').value.trim().toLowerCase();
  const hits=[];
  const push=(label,sub,onclick,tag)=>hits.push({label,sub,onclick,tag});
  DATA.groupings.forEach(g=>{
    if((g.name+" "+g.purpose).toLowerCase().includes(q))
      push(g.name,g.purpose,()=>{spine='rules';stack=[{label:g.name,render:v=>groupView(v,g)}];document.getElementById('q').value='';render();},"grouping");
    g.items.forEach(it=>{
      const scan=f=>{if((f.title+" "+f.name+" "+(f.summary||"")).toLowerCase().includes(q))
        push(f.title||f.name,f.summary||g.name,()=>{spine='rules';stack=[{label:g.name,render:v=>groupView(v,g)},{label:f.name,render:v=>docDetail(v,f)}];document.getElementById('q').value='';render();},g.name);};
      if(it.kind==='file')scan(it); else{if(it.readme)scan(it.readme);it.files.forEach(scan);}
    });
  });
  DATA.tasks.forEach(t=>{
    if((t.namespace+" "+t.purpose).toLowerCase().includes(q))
      push("task "+t.namespace,t.purpose,()=>{spine='tasks';stack=[{label:t.namespace,render:v=>taskDetail(v,t)}];document.getElementById('q').value='';render();},"tasks");
    t.tasks.forEach(tk=>{if((tk.name+" "+tk.desc).toLowerCase().includes(q))
      push("task "+t.namespace+":"+tk.name,tk.desc,()=>{spine='tasks';stack=[{label:t.namespace,render:v=>taskDetail(v,t)}];document.getElementById('q').value='';render();},"task");});
  });
  document.getElementById('foot').textContent=hits.length+" matches";
  if(!hits.length){view.appendChild(el('div','empty','No matches for "'+q+'"'));return;}
  const box=el('div','rows');
  hits.slice(0,120).forEach(h=>{const row=el('div','row');
    const nm=el('div','rname');nm.appendChild(document.createTextNode(h.label));if(h.sub)nm.appendChild(el('span','sub',h.sub));row.appendChild(nm);
    if(h.tag){const rt=el('div','rt');rt.appendChild(el('span','pill',h.tag));row.appendChild(rt);}
    row.appendChild(el('span','chev','›'));row.onclick=h.onclick;box.appendChild(row);});
  view.appendChild(box);
}

document.querySelectorAll('nav.spines button').forEach(b=>b.onclick=()=>reset(b.dataset.spine));
const qEl=document.getElementById('q');
qEl.addEventListener('input',render);
qEl.addEventListener('keydown',e=>{if(e.key==='Escape'){qEl.value='';render();}});

if(!DATA){document.getElementById('view').innerHTML='<div class="empty">No data embedded. Rebuild with <code>task docs:rule-map</code>.</div>';}
else{document.getElementById('sub').textContent="Deft Directive · "+DATA.groupings.length+" rule groups · "+DATA.tasks.length+" task namespaces · maintainer map";render();}
</script>
</body>
</html>
`;
