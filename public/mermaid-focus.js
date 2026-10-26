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

const VERSION = '0.4.0';
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
  let bottom=Math.max(...depth.values(),0);
  for(const n of nodes) if(!depth.has(n.id)) depth.set(n.id,++bottom);
  const rows=new Map();
  for(const n of nodes){const d=depth.get(n.id);if(!rows.has(d))rows.set(d,[]);rows.get(d).push(n);}
  const maxRow=Math.max(1,...[...rows.values()].map(r=>r.length));
  const nodeWidth=290, rowWidth=Math.max(960,maxRow*360+120), rowHeight=158;
  const totalHeight=(Math.max(...rows.keys())+1)*rowHeight+120;
  const positions=new Map();
  for(const [d,group] of rows){
    group.forEach((n,i)=>positions.set(n.id,{x:rowWidth/2 + (i-(group.length-1)/2)*355,y:65+d*rowHeight,w:nodeWidth,h:106}));
  }
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
function focusSvg(graph, current, radius) {
  const edgeList=graph.edges;
  const inward=new Map([[current,0]]), outward=new Map([[current,0]]);
  const walk=(dist, reverse) => {
    let queue=[current];
    for(let i=0;i<queue.length;i++) {
      const id=queue[i], d=dist.get(id);
      if(d >= radius) continue;
      for(const e of edgeList) {
        const next=reverse ? (e.end===id ? e.start : null) : (e.start===id ? e.end : null);
        if(next && !dist.has(next)){dist.set(next,d+1);queue.push(next);}
      }
    }
  };
  walk(inward,true);walk(outward,false);
  const selected=new Set([...inward.keys(),...outward.keys()]);
  const rank = id => {
    if(id===current) return 0;
    const i=inward.get(id),o=outward.get(id);
    if(i!==undefined && (o===undefined || i<o)) return -i;
    return o===undefined?-i:o;
  };
  const arranged=[...selected].sort((a,b)=>{
    let ra=rank(a), rb=rank(b);
    if(ra!==rb)return ra-rb;
    return graph.nodes.findIndex(x=>x.id===a)-graph.nodes.findIndex(x=>x.id===b);
  });
  const nodes=new Map(graph.nodes.map(n=>[n.id,n]));
  const E=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const width=500, cx=250, nodeW=340, top=54;
  const chunks=s=>{
    const output=[];
    for(const section of String(s).split(/\n/)) {
      let line='';
      for(const word of section.split(/\s+/)){
        if(!word)continue;
        if(line && (line+' '+word).length>39){output.push(line);line=word;}
        else line+=(line?' ':'')+word;
      }
      if(line)output.push(line);
    }
    return output.length ? output : [''];
  };
  let cursor=top;
  const coords=new Map();
  for(const id of arranged){
    const lines=chunks(nodes.get(id)?.label||id);
    const height=Math.max(78,24+lines.length*21+14);
    coords.set(id,{x:cx-nodeW/2,y:cursor,w:nodeW,h:height,lines});
    cursor+=height+84;
  }
  const height=Math.max(320,cursor-84+64);
  const arrow='mf-focus-arrow-'+(++uniqueId);
  const out=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" aria-label="Focused flowchart with connected nodes and arrows" role="img">`,
    `<defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#3b82f6"/></marker></defs>`];
  let renderedEdges=0;
  // Draw arrows behind nodes. All edges in the radius are preserved, including
  // direct loops; only genuine decision connections receive active controls.
  for(const e of edgeList){
    const a=coords.get(e.start),b=coords.get(e.end);
    if(!a||!b)continue;
    renderedEdges++;
    const forward=b.y>a.y, centerX=cx;
    let d,x,y;
    if(forward){
      const y1=a.y+a.h, y2=b.y;
      // A long hop must route around intervening nodes, never through them.
      const skipped=arranged.slice(arranged.indexOf(e.start)+1,arranged.indexOf(e.end)).length;
      if(skipped > 0){
        d=`M ${a.x+a.w} ${a.y+a.h/2} C 474 ${a.y+a.h/2}, 474 ${b.y+b.h/2}, ${b.x+b.w+4} ${b.y+b.h/2}`;
        x=360;y=(a.y+a.h/2+b.y+b.h/2)/2;
      }else{
        d=`M ${centerX} ${y1} C ${centerX} ${y1+40} ${centerX} ${y2-40} ${centerX} ${y2-6}`;
        x=centerX+10; y=(y1+y2)/2-4;
      }
    }else{
      const x1=a.x+a.w, x2=b.x+b.w, y1=a.y+a.h/2, y2=b.y+b.h/2;
      d=`M ${x1} ${y1} C 485 ${y1} 485 ${y2} ${x2+5} ${y2}`;
      x=430;y=(y1+y2)/2-3;
    }
    const active=e.start===current;
    out.push(`<path data-edge-start="${E(e.start)}" data-edge-end="${E(e.end)}" d="${d}" fill="none" stroke="${active?'#2563eb':'#94a3b8'}" stroke-width="${active?3:2}" marker-end="url(#${arrow})"/>`);
    if(e.label){
      const label=e.label.length>25?e.label.slice(0,24)+'…':e.label;
      const boxWidth=Math.min(210,Math.max(35,label.length*8+12));
      // White edge-label backing prevents labels from disappearing on arrows.
      const bx=Math.min(width-boxWidth-4,Math.max(2,x));
      out.push(`<rect x="${bx}" y="${y-17}" rx="6" width="${boxWidth}" height="25" fill="#ffffff" stroke="#e2e8f0"/>`);
      out.push(`<text x="${bx+boxWidth/2}" y="${y}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="650" fill="#334155">${E(label)}</text>`);
    }
  }
  for(const id of arranged){
    const p=coords.get(id),node=nodes.get(id),isCurrent=id===current;
    const outgoing=edgeList.some(e=>e.start===current && e.end===id);
    const fill=isCurrent?'#dbeafe':outgoing?'#eff6ff':'#ffffff';
    const stroke=isCurrent?'#1d4ed8':outgoing?'#60a5fa':'#94a3b8';
    const role=outgoing?'role="button" tabindex="0"': '';
    out.push(`<g class="mf-focus-node" data-node-id="${E(id)}" ${role} aria-label="${E(node?.label||id)}">`);
    out.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="${isCurrent?3:2}"/>`);
    if(isCurrent)out.push(`<text x="${cx}" y="${p.y-15}" text-anchor="middle" font-size="12" font-family="system-ui" font-weight="800" fill="#1d4ed8">● CURRENT STEP</text>`);
    const y=p.y+p.h/2-((p.lines.length-1)*21)/2+5;
    p.lines.forEach((line,i)=>out.push(`<text x="${cx}" y="${y+i*21}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="16" font-weight="${isCurrent?750:580}" fill="#14263e">${E(line)}</text>`));
    out.push(`</g>`);
  }
  out.push(`</svg>`);
  return {svg:out.join(''),height,width,count:arranged.length,connections:renderedEdges};
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
.mf-spotlight { background:var(--mf-well); height:clamp(450px,66vh,670px); margin:0; overflow:auto; position:relative; border-bottom:1px solid var(--mf-border); overscroll-behavior:contain; }
.mf-spotlight > div:first-child { width:100%; min-height:100%; }
.mf-spotlight svg { display:block; width:100%; height:auto; max-width:none !important; transition:opacity .22s; }
.mf-focus-node[role="button"] { cursor:pointer; }
.mf-focus-node[role="button"]:hover rect { stroke:#1d4ed8;stroke-width:4; }
.mf-spotlight.mf-overview svg { cursor:zoom-in; }
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
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const state = () => ({ current, path:[...path], mode, focusDepth, terminal: !!graph && !graph.edges.some(e=>e.start===current) });
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
    const previousScrollTop=vision.scrollTop;
    if (overview) {
      const original=opts.svg || builtinSvg;
      if(!original){graphMeta.textContent='Overview unavailable without an SVG.';return;}
      visual.innerHTML=typeof original==='string'?original:'';
      svg=visual.querySelector('svg');
      if (!svg)return;
      // True full graph in a scrollable 2D viewport, not a zoomed-out thumbnail.
      const base=(svg.getAttribute('viewBox')||'0 0 960 1200').split(/\s+/).map(Number);
      const width=base[2]||960,height=base[3]||1200;
      svg.style.width=width+'px';svg.style.height=height+'px';
      vision.style.overflow='auto';
      graphMeta.textContent=`Full overview · ${graph.nodes.length} nodes · ${graph.edges.length} decision paths. Scroll to explore.`;
      requestAnimationFrame(()=>{
        if(!overview || !svg)return;
        const active=svgNode(graph.nodes.find(n=>n.id===current));
        if(active){
          const b=nodeBox(active,svg);
          if(b)vision.scrollTo({left:Math.max(0,b.x+b.w/2-vision.clientWidth/2),top:Math.max(0,b.y+b.h/2-vision.clientHeight/2),behavior:'instant'});
        }
      });
    } else {
      const local=focusSvg(graph,current,focusDepth);
      visual.innerHTML=local.svg;
      svg=visual.querySelector('svg');
      svg.style.width='100%';svg.style.height='auto';
      vision.style.overflow='auto';
      graphMeta.textContent=`${focusDepth} ${focusDepth===1?'hop':'hops'} from current · ${local.count} nodes · ${local.connections} arrows. Tap a next node or choose an answer below.`;
      for(const item of svg.querySelectorAll('.mf-focus-node[role="button"]')){
        const target=item.getAttribute('data-node-id');
        item.addEventListener('click',()=>api.next(target));
        item.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();api.next(target);}});
      }
      visual.animate?.([{opacity:0.65,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:reduceMotion?0:Math.max(120,Math.min(500,opts.duration)),easing:'ease-out'});
    }
    if(previousScrollTop>0 || overview) vision.scrollTop=0;
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
        resizeObserver=new ResizeObserver(() => {if (svg && mode==='spotlight') spotlight();});
        resizeObserver.observe(vision);
      }
    })().finally(()=>{svgRenderPromise=null;});
    return svgRenderPromise;
  }
  const api = {
    getState: state,
    getGraph: () => graph && ({ nodes: graph.nodes.map(n=>({...n})), edges: graph.edges.map(e=>({...e})) }),
    toggleOverview() { overview = !overview; paint(); report(); return overview; },
    setFocusDepth(distance) {
      focusDepth=Math.max(1,Math.min(4,Number(distance)||1));
      depthSelect.value=String(focusDepth);
      overview=false; paint(); report(); return focusDepth;
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
      graph = null; svg = null; svgReady = false; originalBox=null;lastBox=null;overview=false;builtinSvg=null;visual.replaceChildren();
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
export {createMermaidFocus, version};
export default createMermaidFocus;