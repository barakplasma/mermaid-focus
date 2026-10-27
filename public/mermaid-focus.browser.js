(function(){
/**
 * Mermaid Focus v0.2.0 — standalone, CDN-hostable ES module.
 * Copyright (c) 2026. MIT.
 *
 * Turns Mermaid FLOWCHARTS into progressive-disclosure wizard and spotlight views.
 * Common Mermaid flowcharts run completely offline; advanced syntax lazily
 * loads the official Mermaid renderer from jsDelivr unless supplied.
 * No build step, no framework dependency, no stylesheet to install.
 *
 * Public API:
 *   const app = await createMermaidFocus(element, { source, mode: 'wizard' | 'spotlight' });
 *   app.next(nodeId); app.back(); app.restart(); app.setMode(mode);
 *   await app.setSource(source); app.getState(); app.destroy();
 *
 * Mermaid's diagram.db interface is internal/deprecated and may change.
 * If a future version removes it, the caller can instead pass a pre-parsed
 * graph as { nodes:[{id,label,domId?}], edges:[{start,end,label?}] }.
 */

const VERSION = '0.6.0';
const DEFAULT_MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.12.2/dist/mermaid.esm.min.mjs';
let mermaidPromise;
let uniqueId = 0;
let parseQueue = Promise.resolve();
const waitTurn = (work) => {
  const next = parseQueue.catch(() => {}).then(work);
  parseQueue = next.catch(() => {});
  return next;
};

function asText(value) {
  const input = String(value ?? '');
  // Mermaid node labels can contain HTML-style line breaks and entities.
  const html = input.replace(/<br\s*\/?\s*>/gi, '\n');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return (parsed.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
function normalizeGraph(graph) {
  const rawNodes = graph.nodes instanceof Map ? [...graph.nodes.values()] : graph.nodes || [];
  const nodes = rawNodes.map(n => ({ id: String(n.id), label: asText(n.label ?? n.text ?? n.id), domId: n.domId || null, type: n.type || null }));
  const ids = new Set(nodes.map(n => n.id));
  if (!nodes.length) throw Error('Flowchart contains no nodes.');
  if (ids.size !== nodes.length) throw Error('Duplicate node IDs.');
  const edges = (graph.edges || []).map((e, i) => ({
    start: String(e.start ?? e.source), end: String(e.end ?? e.target),
    label: asText(e.label ?? e.text ?? ''), id: e.id || `edge-${i}`,
  }));
  for (const e of edges) {
    if (!ids.has(e.start) || !ids.has(e.end)) throw Error(`Edge ${e.start} -> ${e.end} references an unknown node.`);
  }
  return { nodes, edges };
}
function findStart(graph, explicit) {
  if (explicit != null) {
    if (!graph.nodes.some(n => n.id === explicit)) throw Error(`Unknown start node: ${explicit}`);
    return explicit;
  }
  // Prefer an explicitly named Start node, even when a retry loop returns to it.
  if (graph.nodes.some(n=>n.id==='Start')) return 'Start';
  const inbound = new Set(graph.edges.map(e => e.end));
  return graph.nodes.find(n => !inbound.has(n.id))?.id || graph.nodes[0].id;
}
async function defaultMermaid() {
  if (!mermaidPromise) mermaidPromise = import(DEFAULT_MERMAID_URL).then(m => m.default || m);
  return mermaidPromise;
}
function elt(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function btn(text, onClick, cls = '') {
  const el = elt('button', cls, text);
  el.type = 'button';
  el.addEventListener('click', onClick);
  return el;
}
function nodeBox(node, svg) {
  if (!node || typeof node.getBBox !== 'function') return null;
  try {
    const b = node.getBBox();
    const sm = node.getScreenCTM();
    const rm = svg.getScreenCTM();
    if (!sm || !rm) return null;
    const m = rm.inverse().multiply(sm);
    const xy = [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]]
      .map(([x,y]) => new DOMPoint(x,y).matrixTransform(m));
    const xs = xy.map(p => p.x), ys = xy.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys) };
  } catch { return null; }
}
function union(boxes) {
  const bb = boxes.filter(Boolean);
  if (!bb.length) return null;
  const x = Math.min(...bb.map(b => b.x)), y = Math.min(...bb.map(b => b.y));
  return { x, y, w: Math.max(...bb.map(b => b.x+b.w)) - x, h: Math.max(...bb.map(b => b.y+b.h)) - y };
}
/**
 * Small, network-free compiler for common Mermaid flowcharts. It intentionally
 * supports a subset: one node or one edge per line, labeled --> edges,
 * rounded/box/diamond nodes, plus dotted annotation edges and style lines.
 * For advanced Mermaid syntax, use the full Mermaid engine on a hosted page.
 */
function offlineFlowchart(source) {
  if (!/^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL)\b/im.test(source)) {
    throw Error('Expected a Mermaid flowchart (e.g. flowchart TD).');
  }
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const nodes = new Map(), edges = [], decorations = [];
  const ensure = id => {
    if (!nodes.has(id)) nodes.set(id, {id, label:id, type:'box'});
    return nodes.get(id);
  };
  function definition(fragment) {
    const m = /^\s*([\w-]+)\s*(\{\s*"([\s\S]*?)"\s*\}|\[\s*"([\s\S]*?)"\s*\]|\(\s*"([\s\S]*?)"\s*\)|\{([^{}]*)\}|\[([^\]]*)\]|\(([^()]*)\))\s*;?\s*$/.exec(fragment);
    if (!m) return false;
    const n = ensure(m[1]);
    n.label = asText(m.slice(3).find(x=>x !== undefined) || m[1]);
    n.type = fragment.slice(m[1].length).trim().startsWith('{') ? 'decision' : 'box';
    return true;
  }
  let sawHeader = false;
  for (const original of lines) {
    const line = original.trim();
    if (!line || /^%%/.test(line)) continue;
    if (/^(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL)\b/i.test(line)) { sawHeader=true;continue; }
    if (/^(?:style|classDef|class|linkStyle|click|subgraph|end|direction|accTitle|accDescr)\b/.test(line)) continue;
    const edge = /^([\w-]+)\s*(-->|-\.->|==>|---)\s*(?:\|([^|]*)\|\s*)?([\w-]+)\s*(.*)$/.exec(line);
    if (edge) {
      ensure(edge[1]);
      ensure(edge[4]);
      if (edge[5]?.trim()) definition(edge[4]+edge[5]);
      const record={start:edge[1],end:edge[4],label:asText(edge[3]||'').replace(/^"|"$/g,'')};
      (edge[2]==='-.->' ? decorations : edges).push(record);
      continue;
    }
    if (definition(line)) continue;
    // Don't silently present a misleading flowchart when the subset parser
    // sees syntax it can't understand.
    throw Error(`Unsupported flowchart syntax: ${line.slice(0,110)}. Use the hosted Mermaid engine for advanced diagrams.`);
  }
  if (!sawHeader || nodes.size===0) throw Error('No nodes found.');
  const graph={nodes:[...nodes.values()],edges};
  return {graph,svg:offlineSvg(graph,decorations)};
}
function offlineSvg(graph,decorations=[]) {
  // Simple layered layout; ideal for navigation. This isn't meant to reproduce
  // Mermaid's dagre layout, which requires its full rendering engine.
  const nodes=graph.nodes, edges=graph.edges;
  const idMap = new Map(nodes.map(n=>[n.id,n]));
  const start=nodes.find(n=>n.id==='Start')?.id || nodes[0].id;
  const depth = new Map([[start,0]]), queue=[start];
  while(queue.length) {
    const id=queue.shift(), d=depth.get(id);
    for(const e of edges.filter(e=>e.start===id)) {
      if (!depth.has(e.end)) { depth.set(e.end,d+1);queue.push(e.end); }
    }
  }
  // Group disconnected nodes and independent roots rather than stretching them into one column.
  let bottom=Math.max(...depth.values(),0);
  const missing=nodes.filter(n=>!depth.has(n.id));
  for(let i=0;i<missing.length;i++)depth.set(missing[i].id,bottom+1+Math.floor(i/4));
  const rows=new Map();
  for(const n of nodes){const d=depth.get(n.id);if(!rows.has(d))rows.set(d,[]);rows.get(d).push(n);}
  const maxRow=Math.max(1,...[...rows.values()].map(r=>r.length));
  const nodeWidth=270,spaceX=345,rowWidth=Math.max(1040,Math.min(5,maxRow)*spaceX+200),rowHeight=178;
  const positions=new Map();
  let rowNumber=0;
  for(const [,group] of [...rows.entries()].sort((a,b)=>a[0]-b[0])){
    for(let offset=0;offset<group.length;offset+=5){
      const chunk=group.slice(offset,offset+5);
      chunk.forEach((n,i)=>positions.set(n.id,{x:rowWidth/2+(i-(chunk.length-1)/2)*spaceX,y:65+rowNumber*rowHeight,w:nodeWidth,h:106}));
      rowNumber++;
    }
  }
  const totalHeight=Math.max(400,rowNumber*rowHeight+140);
  const escape = s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  function linesOf(label){
    const pieces=String(label).split(/\n/), result=[];
    for (const part of pieces) {
      let line='';
      for(const word of part.trim().split(/\s+/)){
        if (!word) continue;
        if(line.length+word.length > 29 && line){result.push(line);line=word;} else line+=(line?' ':'')+word;
      }
      result.push(line);
    }
    return result.slice(0,8);
  }
  const markerId = 'mf-arrow-'+(++uniqueId);
  const out=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rowWidth} ${totalHeight}" preserveAspectRatio="xMidYMid meet" aria-label="Flowchart">`,
    `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#94a3b8"/></marker></defs>`];
  for(const [i,e] of [...edges,...decorations].entries()){
    const a=positions.get(e.start),b=positions.get(e.end); if(!a||!b)continue;
    const upward=b.y <= a.y;
    const sx=a.x,sy=upward?a.y:a.y+a.h/2,tx=b.x,ty=upward?b.y+b.h/2:b.y;
    const midY=(sy+ty)/2;
    const path=`M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;
    const dotted=i>=edges.length;
    out.push(`<g class="edge" data-edge-start="${escape(e.start)}" data-edge-end="${escape(e.end)}" data-annotation="${dotted}"><path class="flowchart-link" d="${path}" stroke="${dotted?'#cbd5e1':'#94a3b8'}" stroke-width="2" stroke-dasharray="${dotted?'6 6':'none'}" fill="none" marker-end="url(#${markerId})"/>`);
    if(e.label){const lx=(sx+tx)/2,ly=midY-5;out.push(`<text x="${lx}" y="${ly}" font-size="12" fill="#475569" text-anchor="middle" paint-order="stroke" stroke="#f8fafc" stroke-width="5">${escape(e.label)}</text>`);}
    out.push('</g>');
  }
  for(const n of nodes) {
    const p=positions.get(n.id), lines=linesOf(n.label);
    const h=Math.max(p.h,40+lines.length*20), y=p.y+(p.h-h)/2;
    const id='flowchart-'+n.id+'-'+nodes.indexOf(n);
    const isQuestion=n.type==='decision';
    out.push(`<g class="node" id="${escape(id)}" data-node-id="${escape(n.id)}">`);
    out.push(`<rect x="${p.x-p.w/2}" y="${y}" width="${p.w}" height="${h}" rx="${isQuestion?22:12}" fill="${isQuestion?'#e0f2fe':'#ffffff'}" stroke="${isQuestion?'#0284c7':'#94a3b8'}" stroke-width="2"/>`);
    const firstY=y+h/2-((lines.length-1)*20)/2+5;
    out.push(`<text x="${p.x}" y="${firstY}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#172435" font-weight="${isQuestion?650:550}">`);
    lines.forEach((line,i)=>out.push(`<tspan x="${p.x}" dy="${i?20:0}">${escape(line)}</tspan>`));
    out.push('</text></g>');
  }
  out.push('</svg>');
  return out.join('');
}

/** Diagram-local, directed ego network. SVG stays readable on narrow phones;
 * the complete original SVG is kept separately for Overview. */
function focusSvg(graph,current,radius) {
  // A compact grid per directed hop layer; never linearize an arbitrary graph into one column.
  const links=graph.edges, byId=new Map(graph.nodes.map(n=>[n.id,n]));
  const inward=new Map([[current,0]]),outward=new Map([[current,0]]);
  const walk=(dest,reverse)=>{
    const q=[current];
    for(let i=0;i<q.length;i++){
      const id=q[i],depth=dest.get(id);
      if(depth>=radius)continue;
      for(const e of links){
        const next=reverse?(e.end===id?e.start:null):(e.start===id?e.end:null);
        if(next!==null&&!dest.has(next)){dest.set(next,depth+1);q.push(next);}
      }
    }
  };
  walk(inward,true);walk(outward,false);
  const selected=new Set([...inward.keys(),...outward.keys()]);
  const rank=id=>{
    if(id===current)return 0;
    const incoming=inward.get(id),outgoing=outward.get(id);
    return incoming!==undefined&&(outgoing===undefined||incoming<outgoing)?-incoming:outgoing;
  };
  const levels=new Map();
  for(const n of graph.nodes)if(selected.has(n.id)){
    const r=rank(n.id);
    if(!levels.has(r))levels.set(r,[]);
    levels.get(r).push(n.id);
  }
  const rows=[...levels.entries()].sort((a,b)=>a[0]-b[0]);
  const maxCols=Math.max(1,...rows.map(([,ids])=>Math.min(4,Math.ceil(Math.sqrt(ids.length*1.6)))));
  const nodeW=252,spacingX=306,marginX=78,width=Math.max(450,marginX*2+maxCols*spacingX);
  const coords=new Map();
  const wrap=label=>{
    const output=[];
    for(const paragraph of String(label).split(/\n/)){
      let line="";
      for(const word of paragraph.split(/\s+/)){
        if(!word)continue;
        if(line&&(line+" "+word).length>29){output.push(line);line=word;}
        else line+=(line?" ":"")+word;
      }
      output.push(line);
    }
    return output.length?output:[""];
  };
  let cursorY=65;
  for(const [,ids] of rows){
    const cols=Math.min(maxCols,Math.max(1,Math.ceil(Math.sqrt(ids.length*1.6))));
    for(let offset=0;offset<ids.length;offset+=cols){
      const group=ids.slice(offset,offset+cols);
      const y=cursorY;
      let rowMax=78;
      group.forEach((id,i)=>{
        const lines=wrap(byId.get(id)?.label||id),h=Math.max(78,32+lines.length*19);
        const x=width/2+(i-(group.length-1)/2)*spacingX-nodeW/2;
        coords.set(id,{x,y,w:nodeW,h,lines});
        rowMax=Math.max(rowMax,h);
      });
      cursorY+=rowMax+74;
    }
    cursorY+=36;
  }
  const height=Math.max(330,cursorY+38);
  const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,'"').replace(/"/g,"&quot;");
  const marker="mf-focus-arrow-"+(++uniqueId);
  const out=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Focused directed graph in multiple columns"><defs><marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#3b82f6"/></marker></defs>`];
  const pairs=new Map();let drawn=0;
  for(const e of links){
    const a=coords.get(e.start),b=coords.get(e.end);
    if(!a||!b)continue;
    drawn++;
    const key=e.start+"→"+e.end,parallel=pairs.get(key)||0;
    pairs.set(key,parallel+1);
    let d,lx,ly;
    if(e.start===e.end){
      const sx=a.x+a.w,cy=a.y+a.h/2,bulge=56+parallel*30;
      d=`M${sx-2} ${cy-15} C${sx+bulge} ${cy-78},${sx+bulge} ${cy+80},${sx-2} ${cy+15}`;
      lx=sx+bulge*.65;ly=cy-34;
    }else if(b.y>a.y+25){
      const sx=a.x+a.w/2+(parallel?17*parallel:0),sy=a.y+a.h,tx=b.x+b.w/2+(parallel?17*parallel:0),ty=b.y;
      const diff=Math.max(34,(ty-sy)*.45);
      d=`M${sx} ${sy} C${sx} ${sy+diff},${tx} ${ty-diff},${tx} ${ty-5}`;
      lx=(sx+tx)/2+12;ly=(sy+ty)/2-8;
    }else if(Math.abs(b.y-a.y)<25){
      const right=b.x>a.x;
      const sx=right?a.x+a.w:a.x,tx=right?b.x:b.x+b.w;
      const cy=a.y+a.h/2,dy=b.y+b.h/2;
      d=`M${sx} ${cy} C${sx+(right?56:-56)} ${cy-28-parallel*20},${tx+(right?-56:56)} ${dy-28-parallel*20},${tx} ${dy}`;
      lx=(sx+tx)/2;ly=Math.min(cy,dy)-32-parallel*20;
    }else{
      const sx=a.x+a.w,sy=a.y+a.h*.43,tx=b.x+b.w,ty=b.y+b.h*.55;
      const channel=width-34+parallel*24;
      d=`M${sx} ${sy} C${channel} ${sy-32},${channel} ${ty+32},${tx+4} ${ty}`;
      lx=Math.min(width-120,Math.max(sx,tx)+38);ly=(sy+ty)/2-9;
    }
    const active=e.start===current;
    out.push(`<path data-edge-start="${esc(e.start)}" data-edge-end="${esc(e.end)}" d="${d}" stroke="${active?"#2563eb":"#94a3b8"}" stroke-width="${active?3:2}" fill="none" marker-end="url(#${marker})"/>`);
    if(e.label){
      const label=e.label.length>26?e.label.slice(0,25)+"…":e.label;
      const w=Math.min(210,Math.max(38,label.length*7.3+14));
      const x=Math.max(4,Math.min(width-w-4,lx));
      out.push(`<rect x="${x}" y="${ly-17}" width="${w}" height="24" rx="5" fill="white" stroke="#e2e8f0"/><text x="${x+w/2}" y="${ly}" text-anchor="middle" font-size="12" fill="#334155" font-family="system-ui">${esc(label)}</text>`);
    }
  }
  for(const n of graph.nodes){
    const p=coords.get(n.id);if(!p)continue;
    const active=n.id===current,choice=links.some(e=>e.start===current&&e.end===n.id);
    out.push(`<g class="mf-focus-node" data-node-id="${esc(n.id)}" ${choice?'role="button" tabindex="0"':''} aria-label="${esc(n.label)}"><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="12" stroke="${active?"#1d4ed8":choice?"#60a5fa":"#94a3b8"}" stroke-width="${active?3:2}" fill="${active?"#dbeafe":choice?"#eff6ff":"white"}"/>`);
    if(active)out.push(`<text x="${p.x+p.w/2}" y="${p.y-14}" text-anchor="middle" font-size="11" font-family="system-ui" font-weight="800" fill="#1d4ed8">CURRENT STEP</text>`);
    const first=p.y+p.h/2-(p.lines.length-1)*9.5+4;
    p.lines.forEach((line,i)=>out.push(`<text x="${p.x+p.w/2}" y="${first+i*19}" text-anchor="middle" font-family="system-ui" font-size="14" font-weight="${active?700:550}" fill="#14263e">${esc(line)}</text>`));
    out.push("</g>");
  }
  out.push("</svg>");
  return {svg:out.join(""),height,width,count:coords.size,connections:drawn};
}

const CSS = `
:host { display:block; color-scheme: light; --mf-ink:#172435; --mf-muted:#53647b; --mf-border:#dce2ec; --mf-accent:#2563eb; --mf-bg:#fff; --mf-well:#f5f7fb; font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
* { box-sizing:border-box; }
.mf-shell { color:var(--mf-ink); background:var(--mf-bg); border:1px solid var(--mf-border); border-radius:18px; overflow:hidden; min-height:320px; }
.mf-head { display:flex; align-items:center; gap:10px; padding:13px 16px; border-bottom:1px solid var(--mf-border); flex-wrap:wrap; }
.mf-brand { font-size:15px; font-weight:800; letter-spacing:-.03em; margin-right:auto; }
.mf-modes { display:flex; gap:3px; padding:3px; background:var(--mf-well); border-radius:12px; }
.mf-depth-label { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:var(--mf-muted); }
.mf-depth { font:600 13px system-ui; padding:8px 7px; border:1px solid var(--mf-border); border-radius:8px; background:#fff; color:var(--mf-ink); }
.mf-modes button { background:transparent; border:0; padding:8px 12px; border-radius:9px; font-size:12px; color:var(--mf-muted); cursor:pointer; font-weight:650; }
.mf-modes button[aria-pressed="true"] { background:#fff; box-shadow:0 1px 4px #17243522; color:var(--mf-accent); }
.mf-progress { height:3px; background:var(--mf-accent); }
.mf-body { padding:clamp(20px,5vw,42px); max-width:870px; margin:auto; }
.mf-crumbs { color:var(--mf-muted); text-transform:uppercase; letter-spacing:.12em; font-weight:750; font-size:11px; }
.mf-question { margin:20px 0 27px; font-size:clamp(24px,4.5vw,36px); line-height:1.23; font-weight:760; letter-spacing:-.04em; white-space:pre-line; }
.mf-results { display:grid; gap:10px; max-width:620px; }
.mf-answer { display:flex; align-items:center; justify-content:space-between; gap:14px; min-height:56px; padding:13px 18px; font-family:inherit; text-align:left; font-size:16px; font-weight:620; border:1px solid var(--mf-border); border-radius:12px; background:white; color:var(--mf-ink); cursor:pointer; transition:border-color .15s,background .15s, transform .15s; }
.mf-answer:hover,.mf-answer:focus-visible { border-color:var(--mf-accent); background:#eff6ff; outline:none; transform:translateY(-1px); }
.mf-answer span:last-child { color:var(--mf-accent); font-size:23px; }
.mf-detail { margin:12px 0 21px; padding:15px 18px; border-radius:11px; background:#f5f9ff; border:1px solid #d8e5fa; line-height:1.6; font-size:14px; }
.mf-detail p { margin:0 0 10px; }
.mf-detail ul { margin:0; padding-left:20px; }
.mf-detail li+li { margin-top:8px; }
.mf-graph-meta {padding:8px 16px;font-size:12px;color:#52647b;background:#edf4ff;border-bottom:1px solid var(--mf-border)}
.mf-done { font-size:15px; padding:14px 17px; border-left:3px solid #16a34a; background:#f0fdf4; border-radius:6px; }
.mf-bottom { padding:12px 18px; display:flex; align-items:center; gap:9px; justify-content:space-between; border-top:1px solid var(--mf-border); }
.mf-bottom button { border:1px solid var(--mf-border); background:white; color:var(--mf-ink); border-radius:9px; padding:8px 13px; font:inherit; font-size:13px; cursor:pointer; }
.mf-bottom button:disabled { cursor:default; opacity:.4; }
.mf-counter { color:var(--mf-muted); font-size:12px; }
.mf-spotlight[hidden] { display:none !important; }
.mf-spotlight { background:var(--mf-well); height:clamp(400px,65vh,670px); margin:0; overflow:hidden; position:relative; border-bottom:1px solid var(--mf-border); touch-action:none; cursor:grab; user-select:none; }
.mf-spotlight:active{cursor:grabbing}.mf-spotlight > div:first-child { width:100%; height:100%; }
.mf-spotlight svg { display:block; width:100%; height:100%; max-width:none !important; }
.mf-focus-node[role="button"] { cursor:pointer; }
.mf-focus-node[role="button"]:hover rect { stroke:#1d4ed8;stroke-width:4; }
.mf-camera-controls{position:absolute;left:12px;bottom:12px;z-index:6;display:flex;align-items:center;gap:5px;background:#fffffff5;border:1px solid var(--mf-border);padding:6px;border-radius:11px;box-shadow:0 3px 18px #1e293b20;touch-action:manipulation;cursor:auto}
.mf-camera-controls button{border:1px solid var(--mf-border);background:white;color:#172435;border-radius:7px;font:700 14px system-ui;min-width:35px;min-height:35px;cursor:pointer}
.mf-camera-controls button:hover,.mf-camera-controls button:focus-visible{background:#dbeafe}
.mf-camera-zoom{font:650 12px system-ui;min-width:44px;text-align:center;color:#475569}
.mf-camera-hint{position:absolute;right:12px;bottom:15px;color:#475569;font:11px system-ui;pointer-events:none;background:#ffffffb8;padding:4px 7px;border-radius:6px}
@media(max-width:560px){.mf-camera-hint{display:none}.mf-camera-controls{left:8px;bottom:8px;padding:4px}}
.mf-spotlight .node, .mf-spotlight .edgePath, .mf-spotlight .edgeLabel, .mf-spotlight .flowchart-link { transition:opacity .2s; }
.mf-spotlight .mf-hidden { opacity:0 !important; pointer-events:none !important; }
.mf-loading,.mf-error { padding:30px; background:var(--mf-well); font-size:14px; white-space:pre-wrap; }
.mf-error { color:#b91c1c; }
.mf-overview-button { position:sticky; float:right; z-index:3; top:10px; right:12px; border:1px solid var(--mf-border); background:#ffffffed; padding:5px 10px; border-radius:6px; font:600 12px system-ui; color:var(--mf-ink); cursor:pointer; }
.mf-spotlabel { position:sticky; z-index:2; width:max-content; margin-top:-28px; top:10px; left:12px; font-size:11px; letter-spacing:.07em; text-transform:uppercase; font-weight:700; color:var(--mf-muted); background:#fffdf4e6; border-radius:6px; padding:5px 8px; pointer-events:none; }
@media(max-width:560px){.mf-head{justify-content:space-between}.mf-brand{flex-basis:100%;}.mf-depth-label{margin-left:auto}.mf-spotlight{height:min(65vh,650px)}.mf-body{padding:20px 19px 23px}.mf-question{font-size:clamp(22px,6vw,30px)}}
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { transition:none !important; animation:none !important; } }
`;

async function createMermaidFocus(host, options = {}) {
  if (typeof host === 'string') host = document.querySelector(host);
  if (!(host instanceof Element)) throw new TypeError('createMermaidFocus: host must be an Element or selector.');
  const opts = { mode:'spotlight', focusDepth:1, duration:350, details:{}, ...options };
  let focusDepth = Math.max(1, Math.min(4, Number(opts.focusDepth ?? 1) || 1));
  if (opts.mode !== 'wizard' && opts.mode !== 'spotlight') throw Error('Mode must be "wizard" or "spotlight"');
  const root = host.attachShadow({ mode:'open' });
  const style = elt('style'); style.textContent = CSS; root.append(style);
  const shell = elt('section', 'mf-shell'); root.append(shell);
  const header = elt('div', 'mf-head'); shell.append(header);
  const brand = elt('div', 'mf-brand', opts.title || '◈ Mermaid Focus'); header.append(brand);
  const modes = elt('div', 'mf-modes'); header.append(modes);
  const wizardButton = btn('Wizard', () => api.setMode('wizard'));
  const spotlightButton = btn('Spotlight', () => api.setMode('spotlight'));
  modes.append(wizardButton, spotlightButton);
  const depthLabel=elt('label','mf-depth-label','Connections');
  const depthSelect=elt('select','mf-depth');
  depthSelect.setAttribute('aria-label','Spotlight node distance');
  for(const i of [1,2,3,4]){const op=elt('option','',`${i} ${i===1?'hop':'hops'}`);op.value=String(i);depthSelect.append(op);}
  depthSelect.value=String(focusDepth);
  depthSelect.addEventListener('change',()=>api.setFocusDepth(Number(depthSelect.value)));
  depthLabel.append(depthSelect);header.append(depthLabel);
  const bar = elt('div', 'mf-progress'); shell.append(bar);
  const vision = elt('div', 'mf-spotlight'); vision.hidden = true;
  const visual = elt('div'); vision.append(visual);
  vision.append(elt('div','mf-spotlabel','Focused diagram'));
  const overviewButton = btn('Overview', () => api.toggleOverview(), 'mf-overview-button');
  vision.append(overviewButton);
  const controls=elt('div','mf-camera-controls');controls.setAttribute('aria-label','Pan and zoom controls');
  const zoomOut=btn('−',()=>api.zoomOut(),'mf-zoom-out');zoomOut.title='Zoom out';zoomOut.setAttribute('aria-label','Zoom out');
  const zoomLevel=elt('output','mf-camera-zoom','100%');
  const zoomIn=btn('+',()=>api.zoomIn(),'mf-zoom-in');zoomIn.title='Zoom in';zoomIn.setAttribute('aria-label','Zoom in');
  const fitNodeButton=btn('Center',()=>api.fitNode(),'mf-fit-node');fitNodeButton.title='Center current node';
  const fitAllButton=btn('Fit all',()=>api.fitAll(),'mf-fit-all');fitAllButton.title='Fit visible graph';
  controls.append(zoomOut,zoomLevel,zoomIn,fitNodeButton,fitAllButton);
  const cameraHint=elt('div','mf-camera-hint','Drag to pan · Wheel to zoom');
  vision.append(controls,cameraHint);
  shell.append(vision);
  const graphMeta=elt('div','mf-graph-meta');shell.append(graphMeta);
  const body = elt('main','mf-body'); shell.append(body);
  const footer = elt('footer', 'mf-bottom'); shell.append(footer);
  const backButton = btn('← Back', () => api.back()); footer.append(backButton);
  const count = elt('span','mf-counter'); footer.append(count);
  const restartButton = btn('↻ Restart', () => api.restart()); footer.append(restartButton);

  let graph = null, start = null, current = null, path = [], renderer = opts.mermaid || null, svg = null;
  let svgReady = false, destroyed = false, source = opts.source ?? null, mode = opts.mode;
  let builtinSvg = null;
  let overview = false, animation = null, lastBox = null, resizeObserver = null, svgRenderPromise = null;
  let camera=null, viewSource=null, zoomFactor=1;
  const pointers=new Map();let pointerStart=null,pinchStart=null,suppressNodeClick=false;
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  function viewportAspect(){return Math.max(0.2,vision.clientHeight/Math.max(1,vision.clientWidth));}
  function graphRect(){return viewSource || {x:0,y:0,w:508,h:400};}
  function setCamera(next){
    if(!svg || !next)return;
    const ratio=viewportAspect(), w=clamp(next.w,90,Math.max(20000,graphRect().w*5));
    camera={x:next.x,y:next.y,w,h:w*ratio};
    svg.setAttribute('viewBox',`${camera.x} ${camera.y} ${camera.w} ${camera.h}`);
    svg.setAttribute('preserveAspectRatio','none');
    zoomLevel.textContent=Math.round(100*Math.max(440,Math.min(760,vision.clientWidth*0.85))/camera.w)+'%';
  }
  function fitCurrent(resetZoom=false){
    if(!svg)return;
    if(resetZoom)zoomFactor=1;
    const active=[...svg.querySelectorAll("[data-node-id]")].find(el=>el.getAttribute("data-node-id")===current) || svgNode(graph?.nodes.find(n=>n.id===current));
    let bounds=null;
    if(active){try{bounds=active.getBBox()}catch{}}
    if(!bounds){bounds={x:0,y:0,width:graphRect().w,height:Math.min(120,graphRect().h)}}
    const baseW=Math.max(440,Math.min(760,vision.clientWidth*0.85),bounds.width*1.23)/zoomFactor;
    setCamera({x:bounds.x+bounds.width/2-baseW/2,y:bounds.y+bounds.height/2-(baseW*viewportAspect())/2+18,w:baseW});
  }
  function fitVisible(){
    if(!svg)return;
    const rect=graphRect(),ratio=viewportAspect(),w=Math.max(rect.w*1.10,rect.h*1.10/ratio);
    setCamera({x:rect.x+rect.w/2-w/2,y:rect.y+rect.h/2-(w*ratio)/2,w});
  }
  function zoomAt(multiplier,px=vision.clientWidth/2,py=vision.clientHeight/2){
    if(!camera)return;
    const tx=clamp(px/Math.max(1,vision.clientWidth),0,1),ty=clamp(py/Math.max(1,vision.clientHeight),0,1);
    const nw=clamp(camera.w/multiplier,90,Math.max(20000,graphRect().w*5));
    setCamera({x:camera.x+camera.w*tx-nw*tx,y:camera.y+camera.h*ty-nw*viewportAspect()*ty,w:nw});
    zoomFactor=clamp(zoomFactor*multiplier,0.1,12);
  }
  function panPixels(dx,dy){if(!camera)return;const scale=camera.w/Math.max(1,vision.clientWidth);setCamera({x:camera.x-dx*scale,y:camera.y-dy*scale,w:camera.w});}
  vision.addEventListener('wheel',event=>{
    if(mode!=='spotlight'||event.target.closest('.mf-camera-controls'))return;
    event.preventDefault();
    const rect=vision.getBoundingClientRect();
    zoomAt(Math.exp(-event.deltaY*0.0018),event.clientX-rect.left,event.clientY-rect.top);
  },{passive:false});
  vision.addEventListener('pointerdown',event=>{
    if(mode!=='spotlight'||event.button!==0||event.target.closest('.mf-camera-controls,.mf-overview-button'))return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    pointerStart={x:event.clientX,y:event.clientY,moved:false};
    if(pointers.size===2){const arr=[...pointers.values()];pinchStart={distance:Math.hypot(arr[0].x-arr[1].x,arr[0].y-arr[1].y)};}
  });
  vision.addEventListener('pointermove',event=>{
    const old=pointers.get(event.pointerId);if(!old)return;
    const point={x:event.clientX,y:event.clientY};pointers.set(event.pointerId,point);
    const dx=point.x-old.x,dy=point.y-old.y;
    if(pointerStart && Math.hypot(point.x-pointerStart.x,point.y-pointerStart.y)>6){pointerStart.moved=true;suppressNodeClick=true; if(!vision.hasPointerCapture(event.pointerId))vision.setPointerCapture(event.pointerId);}
    if(pointers.size===2){
      const arr=[...pointers.values()],distance=Math.max(1,Math.hypot(arr[0].x-arr[1].x,arr[0].y-arr[1].y));
      const midpoint={x:(arr[0].x+arr[1].x)/2,y:(arr[0].y+arr[1].y)/2},rect=vision.getBoundingClientRect();
      if(pinchStart)zoomAt(clamp(distance/Math.max(1,pinchStart.distance),0.5,2),midpoint.x-rect.left,midpoint.y-rect.top);
      pinchStart={distance};
    }else if(pointerStart?.moved)panPixels(dx,dy);
  });
  const release=event=>{pointers.delete(event.pointerId);if(pointers.size<2)pinchStart=null;if(!pointers.size)pointerStart=null;};
  vision.addEventListener('pointerup',release);vision.addEventListener('pointercancel',release);
  vision.addEventListener('click',event=>{if(suppressNodeClick){event.preventDefault();event.stopImmediatePropagation();suppressNodeClick=false;}},true);
  vision.addEventListener('dblclick',event=>{if(event.target.closest('.mf-camera-controls,.mf-overview-button'))return;const r=vision.getBoundingClientRect();zoomAt(1.6,event.clientX-r.left,event.clientY-r.top);});
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = () => ({ current, path:[...path], mode, focusDepth, camera:camera&&({...camera}), terminal: !!graph && !graph.edges.some(e=>e.start===current) });
  const report = () => { if (typeof opts.onChange === 'function') opts.onChange(state()); };
  function paint() {
    if (destroyed || !graph) return;
    const item = graph.nodes.find(n => n.id === current);
    const choices = graph.edges.filter(e => e.start === current);
    body.replaceChildren();
    body.append(elt('div','mf-crumbs',`Step ${path.length + 1} · ${choices.length ? `${choices.length} ${choices.length === 1 ? 'path' : 'paths'}` : 'Outcome'}`));
    const heading = elt('h2','mf-question',item.label || item.id);
    heading.setAttribute('aria-live','polite');
    body.append(heading);
    const detail=opts.details?.[current];
    if (detail) {
      const container=elt('section','mf-detail');
      if (typeof detail==='string') container.append(elt('p','',detail));
      else if (Array.isArray(detail)){
        const list=elt('ul');for(const line of detail)list.append(elt('li','',String(line)));container.append(list);
      } else {
        if(detail.intro)container.append(elt('p','',detail.intro));
        if(detail.steps?.length){const list=elt('ul');for(const line of detail.steps)list.append(elt('li','',String(line)));container.append(list);}
      }
      body.append(container);
    }
    if (choices.length) {
      const group = elt('div','mf-results'); group.setAttribute('role','group'); group.setAttribute('aria-label', 'Choose the next step');
      for (const e of choices) {
        const target = graph.nodes.find(n => n.id === e.end);
        const choice = btn('', () => api.next(e.end), 'mf-answer');
        choice.append(elt('span','',e.label || (choices.length === 1 ? 'Continue' : target.label || target.id)),elt('span','','→'));
        choice.setAttribute('aria-label',`${e.label || target.label || 'Continue'}: go to ${target.label}`);
        group.append(choice);
      }
      body.append(group);
    } else {
      body.append(elt('div', 'mf-done','End of this path. Go back to reconsider an answer, or restart.'));
    }
    backButton.disabled = path.length === 0;
    count.textContent = `${path.length} ${path.length === 1 ? 'decision' : 'decisions'} made`;
    wizardButton.setAttribute('aria-pressed',String(mode === 'wizard'));
    spotlightButton.setAttribute('aria-pressed',String(mode === 'spotlight'));
    vision.hidden = mode !== 'spotlight';
    graphMeta.hidden = mode !== 'spotlight';
    depthLabel.hidden = mode !== 'spotlight';
    overviewButton.textContent = overview ? 'Focus' : 'Overview';
    vision.classList.toggle('mf-overview',overview);
    if (mode === 'spotlight' && svg) spotlight();
    // Cyclic decision trees have no meaningful percentage-complete value.
  }
  function svgNode(item) {
    if (!svg || !item) return null;
    if (opts.nodeMap?.[item.id]) {
      const custom = svg.querySelector(opts.nodeMap[item.id]);
      if (custom) return custom;
    }
    const groups = [...svg.querySelectorAll('g.node, g[data-node-id], g[data-id], g[id]')];
    const candidates = [item.domId, item.id, `flowchart-${item.id}`].filter(Boolean);
    const exact = groups.find(n => candidates.includes(n.id) ||
      n.getAttribute('data-node-id') === item.id || n.getAttribute('data-id') === item.id ||
      n.getAttribute('data-node') === item.id);
    if (exact) return exact;
    const prefixed = groups.find(n => n.id?.startsWith(`flowchart-${item.id}-`) ||
      n.id?.startsWith(`node-${item.id}-`) || n.id?.endsWith(`-${item.id}`));
    if (prefixed) return prefixed;
    // Best-effort Ondine/SVG matching when a compiler does not preserve the node ID.
    // Only match uniquely to avoid focusing on the wrong node.
    const named = groups.filter(n => asText(n.textContent) === item.label);
    return named.length === 1 ? named[0] : null;
  }
  function svgBounds() {
    const base = svg.viewBox.baseVal;
    if (base?.width > 0 && base?.height > 0) return {x:base.x,y:base.y,w:base.width,h:base.height};
    const b = svg.getBBox();
    return {x:b.x,y:b.y,w:Math.max(1,b.width),h:Math.max(1,b.height)};
  }
  function applyView(box) {
    svg.setAttribute('viewBox',`${box.x} ${box.y} ${box.w} ${box.h}`);
    svg.setAttribute('preserveAspectRatio','xMidYMid meet');
  }
  function zoomTo(target) {
    if (!target) return;
    if (animation) cancelAnimationFrame(animation);
    const from = lastBox || svgBounds();
    // Respect motion preferences and allow a zero-duration animation.
    if (reduceMotion || opts.duration <= 0) { applyView(target); lastBox=target; return; }
    const startTime=performance.now(), duration=Math.max(0,Number(opts.duration)||540);
    function frame(now) {
      if (destroyed || !svg) return;
      const t = Math.max(0, Math.min(1,(now-startTime)/duration));
      const ease = t*t*(3-2*t);
      const b = {
        x:from.x+(target.x-from.x)*ease, y:from.y+(target.y-from.y)*ease,
        w:from.w+(target.w-from.w)*ease, h:from.h+(target.h-from.h)*ease,
      };
      applyView(b);
      lastBox=b;
      animation = t<1 ? requestAnimationFrame(frame) : null;
    }
    animation=requestAnimationFrame(frame);
  }
  function spotlight() {
    if (!graph || mode !== 'spotlight') return;
    if (overview) {
      const original=opts.svg || builtinSvg;
      if(!original){graphMeta.textContent='Overview unavailable without an SVG.';return;}
      visual.innerHTML=typeof original==='string'?original:'';
      svg=visual.querySelector('svg');if(!svg)return;
      const base=(svg.getAttribute('viewBox')||'0 0 960 1200').split(/\s+/).map(Number);
      viewSource={x:base[0]||0,y:base[1]||0,w:base[2]||960,h:base[3]||1200};
      graphMeta.textContent=`Full overview · ${graph.nodes.length} nodes · ${graph.edges.length} decision paths · pan and zoom to explore.`;
    } else {
      const local=focusSvg(graph,current,focusDepth);
      visual.innerHTML=local.svg;
      svg=visual.querySelector('svg');
      viewSource={x:0,y:0,w:local.width,h:local.height};
      graphMeta.textContent=`${focusDepth} ${focusDepth===1?'hop':'hops'} from current · ${local.count} nodes · ${local.connections} arrows · drag, zoom, or tap an adjacent node.`;
      for(const item of svg.querySelectorAll('.mf-focus-node[role="button"]')){
        const target=item.getAttribute('data-node-id');
        item.addEventListener('click',()=>{if(!suppressNodeClick)api.next(target)});
        item.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();api.next(target);}});
      }
    }
    svg.style.width='100%';svg.style.height='100%';
    fitCurrent(false);
  }
  let originalBox = null;
  async function renderSpotlight() {
    if (svgReady) return;
    if (svgRenderPromise) return svgRenderPromise;
    svgRenderPromise = (async () => {
      if (opts.svg || builtinSvg) {
        // Trust only precompiled SVG you control; never feed arbitrary unsanitized SVG.
        const input = opts.svg ? (typeof opts.svg === 'function' ? await opts.svg() : opts.svg) : builtinSvg;
        visual.innerHTML = input;
      } else {
        if (!source) throw Error('For Spotlight, provide Mermaid source or a compiled SVG.');
        if (!renderer) renderer = await defaultMermaid();
        if (typeof renderer.render !== 'function') throw Error('Mermaid renderer must implement render(id, source).');
        const rendered = await waitTurn(() => renderer.render(`mf-svg-${++uniqueId}`,source));
        if (destroyed) return;
        visual.innerHTML=rendered.svg;
      }
      svg=visual.querySelector('svg');
      if (!svg) throw Error('Diagram renderer produced no SVG.');
      svg.setAttribute('role','img');
      svg.setAttribute('aria-label','Focused flowchart. Choose an answer below to move to the next step.');
      originalBox=svgBounds();
      svg.removeAttribute('width');svg.removeAttribute('height');
      svgReady=true;
      if (!resizeObserver && 'ResizeObserver' in window) {
        resizeObserver=new ResizeObserver(() => {if (svg && mode==='spotlight' && camera) {const center={x:camera.x+camera.w/2,y:camera.y+camera.h/2};setCamera({x:center.x-camera.w/2,y:center.y-camera.w*viewportAspect()/2,w:camera.w});}});
        resizeObserver.observe(vision);
      }
    })().finally(()=>{svgRenderPromise=null;});
    return svgRenderPromise;
  }
  const api = {
    getState: state,
    getGraph: () => graph && ({ nodes: graph.nodes.map(n=>({...n})), edges: graph.edges.map(e=>({...e})) }),
    getCamera: () => camera&&({...camera}),
    zoomIn(){zoomAt(1.28)}, zoomOut(){zoomAt(1/1.28)},
    fitNode(){fitCurrent(true)}, fitAll(){fitVisible()},
    toggleOverview() { overview = !overview; paint(); report(); return overview; },
    setFocusDepth(distance) {
      focusDepth=Math.max(1,Math.min(4,Number(distance)||1));
      depthSelect.value=String(focusDepth);
      overview=false; paint(); report(); return focusDepth;
    },
    jumpTo(id) {
      // Debugging and disconnected graphs: switch to any node, without treating
      // an impossible cross-component jump as a real decision in the history.
      if (!graph || !graph.nodes.some(n=>n.id===id)) return false;
      if (current === id) return true;
      path=[]; current=id; overview=false; paint(); report(); return true;
    },
    next(id) {
      if (!graph || !graph.edges.some(e=>e.start===current && e.end===id)) return false;
      path.push(current); current = id; paint(); report(); return true;
    },
    back() { if (!path.length) return false; current = path.pop(); paint(); report(); return true; },
    restart() { if (!graph) return; path=[];current=start;paint();report(); },
    async setMode(nextMode) {
      if (nextMode !== 'wizard' && nextMode !== 'spotlight') throw Error('Unknown mode');
      mode = nextMode; paint();
      if (mode === 'spotlight' && !svgReady && (source || opts.svg)) {
        vision.hidden = false; visual.textContent = 'Preparing diagram…';
        try { await renderSpotlight(); paint(); } catch(err) { visual.replaceChildren(elt('div','mf-error',`Spotlight unavailable: ${err.message}`)); }
      }
      report();
    },
    async setSource(newSource, suppliedGraph = null) {
      source = newSource;
      if (animation) cancelAnimationFrame(animation); animation=null;
      graph = null; svg = null; svgReady = false; originalBox=null;lastBox=null;overview=false;builtinSvg=null;camera=null;zoomFactor=1;visual.replaceChildren();
      body.replaceChildren(elt('div','mf-loading','Reading flowchart…'));
      try {
        if (suppliedGraph || opts.graph) {
          graph = normalizeGraph(suppliedGraph || opts.graph);
        } else {
          if (!source?.trim()) throw Error('Provide a Mermaid flowchart source or a graph.');
          if (!/^\s*(?:---[\s\S]*?---\s*)?(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL)\b/i.test(source)) {
            throw Error('Only Mermaid flowchart/graph diagrams are supported. Other diagram types do not define wizard branches.');
          }
          if (!renderer && opts.engine !== 'mermaid') {
            try {
              const built = offlineFlowchart(source);
              graph = normalizeGraph(built.graph);
              builtinSvg = built.svg;
            } catch (error) {
              if (opts.engine === 'builtin') throw error;
              // Fall back to official Mermaid when a diagram exceeds the
              // built-in subset. This path requires a network connection.
            }
          }
          if (!graph) {
          if (!renderer) renderer = await defaultMermaid();
          if (typeof renderer.initialize === 'function') renderer.initialize({ startOnLoad:false, securityLevel:'strict', flowchart:{ htmlLabels:false } });
          const raw = await waitTurn(async () => {
            const fn = renderer.mermaidAPI?.getDiagramFromText || renderer.getDiagramFromText;
            if (!fn) throw Error('Mermaid graph extraction unavailable. Pass options.graph or a compatible Mermaid 11 build.');
            const parsed = await fn(source);
            if (!parsed.db?.getVertices || !parsed.db?.getEdges) throw Error('Mermaid flowchart database not available.');
            return normalizeGraph({ nodes:parsed.db.getVertices(), edges:parsed.db.getEdges() });
          });
          graph = raw;
          }
        }
        if (destroyed) return;
        start = findStart(graph, opts.startId);
        path = []; current = start;
        paint();
        if (mode === 'spotlight') await api.setMode('spotlight');
        else report();
      } catch (error) {
        if (!destroyed) { body.replaceChildren(elt('div','mf-error',error.message)); count.textContent='Unable to load'; }
        throw error;
      }
    },
    destroy() { destroyed=true; if(animation) cancelAnimationFrame(animation); resizeObserver?.disconnect(); root.replaceChildren(); },
  };
  if (source || opts.graph) await api.setSource(source, opts.graph);
  else body.append(elt('div','mf-loading','No flowchart loaded. Call setSource(source).'));
  return api;
}

const version = VERSION;
window.MermaidFocus = {createMermaidFocus, version};

})();