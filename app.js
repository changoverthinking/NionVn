(function(){
"use strict";

/* ============ State (in-memory; use Export/Import to persist) ============ */
const state = {
  view:"dict",
  history:[],        // {type, key, label, ts}
  favorites:{},       // key -> vocab object
  mylist:{},           // key -> vocab object
  notes:{},             // key -> text
  fc:{},                  // key -> {box:0-4}
  customVocab:[],          // từ do người dùng tự thêm (từ sách của họ)
  customGrammar:[],         // mẫu ngữ pháp do người dùng tự thêm
  customKanji:[],            // kanji do người dùng tự thêm/sửa
  settings:{theme:"light", bigfont:false, lang:"vi"},
  dictDir:"any",
  jlpt:{level:"N5", type:"vocab", questions:[], idx:0, score:0, active:false},
  reading:{current:0},
  flashcard:{deckKeys:[], idx:0, flipped:false}
};

const $ = (sel,root=document)=>root.querySelector(sel);
const $$ = (sel,root=document)=>Array.from(root.querySelectorAll(sel));

/* ============ Auto-save (localStorage) ============
   NionVN chạy như một file/ứng dụng cục bộ trong trình duyệt của bạn (không phải
   trong khung xem trước của Claude.ai), nên localStorage hoạt động bình thường và
   an toàn — dữ liệu chỉ lưu trên máy bạn, không gửi đi đâu cả. */
const STORAGE_KEY = "nionvn_data_v1";
let saveTimer = null;
function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToStorage, 400);
}
function saveToStorage(){
  try{
    const payload = {favorites:state.favorites, mylist:state.mylist, notes:state.notes, fc:state.fc, history:state.history, settings:state.settings, customVocab:state.customVocab, customGrammar:state.customGrammar, customKanji:state.customKanji};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }catch(e){ /* storage full or unavailable - silently ignore, Export/Import still works */ }
}
function loadFromStorage(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const data = JSON.parse(raw);
    state.favorites = data.favorites || {};
    state.mylist = data.mylist || {};
    state.notes = data.notes || {};
    state.fc = data.fc || {};
    state.history = data.history || [];
    state.customVocab = data.customVocab || [];
    state.customGrammar = data.customGrammar || [];
    state.customKanji = data.customKanji || [];
    state.settings = Object.assign(state.settings, data.settings||{});
  }catch(e){ /* corrupted data - start fresh */ }
}

function vkey(v){ return (v.kanji||"")+"|"+(v.hira||""); }
function kkey(k){ return k.char; }
function levelSlug(lvl){ return (lvl||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,""); }
function allVocab(){
  const map = new Map();
  (typeof IMPORTED_VOCAB!=="undefined"?IMPORTED_VOCAB:[]).forEach(v=>map.set(vkey(v), v));
  VOCAB_CLEAN.forEach(v=>map.set(vkey(v), v));
  state.customVocab.forEach(v=>map.set(vkey(v), v)); // từ đã sửa/thêm luôn được ưu tiên, ghi đè bản gốc
  return [...map.values()];
}
function allGrammar(){ return [...GRAMMAR, ...state.customGrammar]; }
function allKanji(){
  const map = new Map();
  (typeof IMPORTED_KANJI!=="undefined"?IMPORTED_KANJI:[]).forEach(k=>map.set(k.char, k));
  KANJI_CLEAN.forEach(k=>map.set(k.char, k));
  state.customKanji.forEach(k=>map.set(k.char, k)); // kanji đã sửa/thêm luôn được ưu tiên
  return [...map.values()];
}

function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._h); toast._h = setTimeout(()=>t.classList.remove("show"), 1800);
}

/* ============ Text to speech ============ */
function speak(text, lang){
  if(!('speechSynthesis' in window)){ toast("Trình duyệt không hỗ trợ phát âm."); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang || "ja-JP";
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
}

/* ============ Voice search (Web Speech API, may require the OS/browser's own engine) ============ */
function setupMic(btn, onResult){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ btn.disabled = true; btn.title = "Trình duyệt này không hỗ trợ nhận dạng giọng nói"; return; }
  let rec = null, listening = false;
  btn.addEventListener("click", ()=>{
    if(listening){ rec && rec.stop(); return; }
    rec = new SR();
    rec.lang = "ja-JP";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = ()=>{ listening = true; btn.classList.add("listening"); };
    rec.onend = ()=>{ listening = false; btn.classList.remove("listening"); };
    rec.onerror = ()=>{ listening = false; btn.classList.remove("listening"); toast("Không nhận dạng được giọng nói."); };
    rec.onresult = (e)=>{ const text = e.results[0][0].transcript; onResult(text); };
    try{ rec.start(); }catch(e){ toast("Không thể khởi động micro."); }
  });
}

/* ============ History ============ */
function logHistory(type, label, key){
  state.history.unshift({type,label,key,ts:Date.now()});
  state.history = state.history.slice(0,200);
  scheduleSave();
}

/* ============ DICTIONARY ============ */
function normalize(s){ return (s||"").toLowerCase().trim(); }

function searchDict(query, dir){
  const q = normalize(query);
  if(!q) return [];
  return allVocab().filter(v=>{
    const hitJP = normalize(v.kanji).includes(q) || normalize(v.hira).includes(q) || normalize(v.kata).includes(q) || normalize(v.romaji).includes(q);
    const hitVI = v.vi.some(m=>normalize(m).includes(q));
    const hitEN = v.en.some(m=>normalize(m).includes(q));
    if(dir==="jv") return hitJP;
    if(dir==="vj") return hitVI;
    return hitJP || hitVI || hitEN;
  });
}

function wordCardHTML(v){
  const key = vkey(v);
  const isFav = !!state.favorites[key];
  const isList = !!state.mylist[key];
  const note = state.notes[key] || "";
  const hasMeaning = v.vi && v.vi.length>0;
  return `
  <div class="card" data-key="${escapeAttr(key)}">
    <div class="word-title">
      <span class="jp">${v.kanji}</span>
      <span class="kana">${v.hira}${v.kata? " / "+v.kata:""}</span>
      <span class="romaji">${v.romaji||""}</span>
      <span class="pill level lvl-${levelSlug(v.level)}">${v.level}</span>
      ${v.pos? `<span class="pill">${v.pos}</span>`:""}
    </div>
    <div class="muted" style="font-size:.8rem;margin-top:.2rem;">${v.topic||""}</div>
    <div style="margin-top:.5rem;"><b>Nghĩa (VI):</b> ${hasMeaning? v.vi.join("; ") : `<span class="muted">(chưa có nghĩa — dữ liệu nhập từ CSV)</span>`}</div>
    ${v.en && v.en.length? `<div><b>Nghĩa (EN):</b> ${v.en.join("; ")}</div>`:""}
    ${v.jp? `<div class="muted" style="margin-top:.3rem;"><b>日本語:</b> ${v.jp}</div>`:""}
    ${(v.examples||[]).map(ex=>`<div class="example"><div class="jp">${ex.jp}</div><div class="muted">${ex.romaji||""}</div><div>${ex.vi}</div></div>`).join("")}
    ${v.synonyms && v.synonyms.length? `<div style="margin-top:.3rem;"><b>Đồng nghĩa/liên quan:</b> ${v.synonyms.join(", ")}</div>`:""}
    ${v.compounds && v.compounds.length? `<div><b>Từ ghép:</b> ${v.compounds.join(", ")}</div>`:""}
    <div class="row-actions">
      <button class="act-speak">🔊 Phát âm</button>
      <button class="act-img">🖼 Hình ảnh liên quan</button>
      <button class="act-fav ${isFav?'active':''}">${isFav? '★ Đã lưu':'☆ Yêu thích'}</button>
      <button class="act-list ${isList?'active':''}">${isList? '✓ Trong danh sách':'+ Thêm vào danh sách học'}</button>
      ${!hasMeaning? `<button onclick="window.editVocabPrompt('${escapeAttr(key)}')">✏️ Bổ sung nghĩa</button>`:""}
    </div>
    <textarea class="note" placeholder="Ghi chú cá nhân của bạn về từ này…">${escapeHtml(note)}</textarea>
  </div>`;
}
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function escapeAttr(s){ return escapeHtml(s); }

function bindWordCardActions(container){
  $$(".card[data-key]", container).forEach(card=>{
    const key = card.dataset.key;
    const v = allVocab().find(v=>vkey(v)===key);
    if(!v) return;
    $(".act-speak",card)?.addEventListener("click",()=>speak(v.kanji||v.hira,"ja-JP"));
    $(".act-img",card)?.addEventListener("click",()=>{
      const url = "https://www.google.com/search?tbm=isch&q="+encodeURIComponent(v.kanji||v.hira);
      window.open(url,"_blank");
    });
    $(".act-fav",card)?.addEventListener("click",(e)=>{
      if(state.favorites[key]){ delete state.favorites[key]; e.target.classList.remove("active"); e.target.textContent="☆ Yêu thích"; }
      else{ state.favorites[key]=v; e.target.classList.add("active"); e.target.textContent="★ Đã lưu"; }
      scheduleSave();
    });
    $(".act-list",card)?.addEventListener("click",(e)=>{
      if(state.mylist[key]){ delete state.mylist[key]; e.target.classList.remove("active"); e.target.textContent="+ Thêm vào danh sách học"; }
      else{ state.mylist[key]=v; e.target.classList.add("active"); e.target.textContent="✓ Trong danh sách"; }
      scheduleSave();
    });
    $(".note",card)?.addEventListener("change",(e)=>{ state.notes[key]=e.target.value; scheduleSave(); });
  });
}

function renderDictResults(list){
  const box = $("#dictResults");
  if(!list.length){ box.innerHTML = `<div class="empty"><span class="big-ico">🔍</span>Không tìm thấy kết quả. Thử từ khóa khác nhé.</div>`; return; }
  const CAP = 60;
  const shown = list.slice(0, CAP);
  box.innerHTML = shown.map(wordCardHTML).join("") +
    (list.length>CAP? `<div class="muted" style="text-align:center;padding:.6rem;">Tìm thấy ${list.length} kết quả, đang hiện ${CAP} kết quả đầu. Hãy gõ từ khóa cụ thể hơn để thu hẹp.</div>` : "");
  bindWordCardActions(box);
}

function doDictSearch(){
  const q = $("#dictInput").value;
  if(!q.trim()) return;
  const res = searchDict(q, state.dictDir);
  renderDictResults(res);
  logHistory("dict", q);
}

/* ============ KANJI ============ */
function kanjiCardHTML(k){
  return `<div class="kanji-tile" data-char="${k.char}">
    <div class="big">${k.char}</div>
    <div class="m">${k.meaning || (k.imported? "(chưa có nghĩa)" : "")}</div>
    <div class="pill level lvl-${levelSlug(k.level)}" style="margin-top:.3rem;">${k.level}</div>
  </div>`;
}
function kanjiDetailHTML(k){
  return `<div class="card">
    <div class="word-title"><span class="jp" style="font-size:2.2rem;">${k.char}</span>
      <span class="pill level lvl-${levelSlug(k.level)}">${k.level}</span><span class="pill">${k.strokes||"?"} nét</span><span class="pill">Bộ: ${k.radical||"?"}</span></div>
    <div style="margin-top:.4rem;"><b>Nghĩa:</b> ${k.meaning || `<span class="muted">(chưa có nghĩa — dữ liệu nhập từ CSV, vào Công cụ để bổ sung)</span>`}</div>
    <div><b>Âm On'yomi:</b> ${(k.onyomi||[]).join("、")||"—"}</div>
    <div><b>Âm Kun'yomi:</b> ${(k.kunyomi||[]).join("、")||"—"}</div>
    ${(k.compounds||[]).length? `<div style="margin-top:.4rem;"><b>Từ ghép:</b>${k.compounds.map(c=>`<div class="example"><span class="jp">${c.word}</span> (${c.reading}) — ${c.meaning}</div>`).join("")}</div>`:""}
    <div class="row-actions"><button onclick="window.speakJP('${k.char}')">🔊 Phát âm</button>${k.imported? `<button onclick="window.editKanjiPrompt('${k.char}')">✏️ Bổ sung nghĩa</button>`:""}</div>
  </div>`;
}
window.speakJP = (t)=>speak(t,"ja-JP");
window.editKanjiPrompt = (ch)=>{ showView("tools"); $$("#toolsSubRow .chip").forEach(c=>c.classList.toggle("on", c.dataset.tsub==="edit")); $$(".tools-pane").forEach(p=>p.classList.add("hidden")); $("#tools-edit").classList.remove("hidden"); openEditTableFor("kanji", ch); };

let kanjiLevelFilter = "all";
let kanjiPageSize = 120, kanjiShown = 120;
function renderKanjiList(reset=true){
  if(reset) kanjiShown = kanjiPageSize;
  const q = normalize($("#kanjiInput").value);
  let list = allKanji().filter(k=>{
    if(kanjiLevelFilter!=="all" && k.level!==kanjiLevelFilter) return false;
    if(!q) return true;
    return k.char.includes(q) || (k.meaning||"").toLowerCase().includes(q) ||
      (k.onyomi||[]).join(" ").toLowerCase().includes(q) || (k.kunyomi||[]).join(" ").toLowerCase().includes(q);
  });
  const box = $("#kanjiResults");
  if(!list.length){ box.innerHTML = `<div class="empty"><span class="big-ico">漢</span>Không tìm thấy Kanji phù hợp.</div>`; return; }
  const shown = list.slice(0, kanjiShown);
  const more = list.length - shown.length;
  box.innerHTML = shown.map(kanjiCardHTML).join("") +
    (more>0? `<div style="grid-column:1/-1;text-align:center;padding:.8rem;"><button class="btn" id="kanjiLoadMore">Tải thêm (${more} còn lại)</button></div>` : `<div style="grid-column:1/-1;text-align:center;" class="muted">Đã hiện tất cả ${list.length} Kanji.</div>`);
  $$(".kanji-tile", box).forEach(tile=>{
    tile.addEventListener("click",()=>{
      const k = allKanji().find(k=>k.char===tile.dataset.char);
      box.insertAdjacentHTML("beforebegin", kanjiDetailHTML(k));
      logHistory("kanji", k.char);
      $("main").scrollIntoView({behavior:"smooth"});
    });
  });
  $("#kanjiLoadMore")?.addEventListener("click",()=>{ kanjiShown += kanjiPageSize; renderKanjiList(false); });
}

/* Handwriting canvas (simple stroke-count based matching) */
function setupHandwriting(){
  const canvas = $("#handwriteCanvas");
  const ctx = canvas.getContext("2d");
  ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--ink") || "#231f1a";
  let drawing = false, strokeCount = 0;
  function pos(e){
    const r = canvas.getBoundingClientRect();
    const p = e.touches? e.touches[0] : e;
    return {x: (p.clientX-r.left)*(canvas.width/r.width), y:(p.clientY-r.top)*(canvas.height/r.height)};
  }
  function start(e){ drawing = true; strokeCount++; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); e.preventDefault(); }
  function move(e){ if(!drawing) return; const p = pos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); e.preventDefault(); }
  function end(){ drawing = false; }
  canvas.addEventListener("mousedown",start); canvas.addEventListener("mousemove",move); window.addEventListener("mouseup",end);
  canvas.addEventListener("touchstart",start); canvas.addEventListener("touchmove",move); canvas.addEventListener("touchend",end);
  $("#hwClear").addEventListener("click",()=>{ ctx.clearRect(0,0,canvas.width,canvas.height); strokeCount=0; $("#hwResult").textContent=""; });
  $("#hwGuess").addEventListener("click",()=>{
    if(strokeCount===0){ $("#hwResult").textContent = "Hãy vẽ một chữ Kanji trước."; return; }
    const candidates = allKanji().filter(k=>Math.abs(k.strokes-strokeCount)<=1).sort((a,b)=>Math.abs(a.strokes-strokeCount)-Math.abs(b.strokes-strokeCount)).slice(0,8);
    if(!candidates.length){ $("#hwResult").textContent = "Không tìm thấy gợi ý phù hợp."; return; }
    $("#hwResult").innerHTML = "Gợi ý theo số nét vẽ được ("+strokeCount+" nét) — độ chính xác giới hạn trong bản offline: "+
      candidates.map(k=>`<span class="jp" style="font-size:1.3rem;cursor:pointer;margin-right:.4rem;" data-c="${k.char}">${k.char}</span>`).join("");
    $$("span[data-c]", $("#hwResult")).forEach(s=>s.addEventListener("click",()=>{
      $("#kanjiInput").value = s.dataset.c; kanjiLevelFilter="all";
      $$("#kanjiLevelRow .chip").forEach(c=>c.classList.remove("on")); $("#kanjiLevelRow .chip[data-lvl=all]").classList.add("on");
      renderKanjiList();
    }));
  });
}

/* ============ GRAMMAR ============ */
let grammarLevelFilter = "all";
function grammarCardHTML(g){
  return `<div class="card">
    <div class="word-title"><span class="jp" style="font-size:1.3rem;">${g.pattern}</span><span class="pill level lvl-${g.level}">${g.level}</span></div>
    <div style="margin-top:.3rem;"><b>Ý nghĩa:</b> ${g.meaning}</div>
    <div><b>Cấu trúc:</b> ${g.structure}</div>
    <div><b>Cách dùng:</b> ${g.usage}</div>
    ${g.examples.map(ex=>`<div class="example"><div class="jp">${ex.jp}</div><div>${ex.vi}</div></div>`).join("")}
  </div>`;
}
function renderGrammar(){
  const q = normalize($("#grammarInput").value);
  let list = allGrammar().filter(g=>{
    if(grammarLevelFilter!=="all" && g.level!==grammarLevelFilter) return false;
    if(!q) return true;
    return g.pattern.toLowerCase().includes(q) || g.meaning.toLowerCase().includes(q);
  });
  const box = $("#grammarResults");
  box.innerHTML = list.length? list.map(grammarCardHTML).join("") : `<div class="empty"><span class="big-ico">📝</span>Không tìm thấy mẫu ngữ pháp phù hợp.</div>`;
}

/* ============ TRANSLATE (câu — có giải chia động từ + liên kết ngữ pháp) ============ */
let tdir = "jv";

/* -- Bộ giải chia động từ/tính từ đơn giản (không phải AI, dựa trên quy tắc ngữ pháp) -- */
function deinflectCandidates(word){
  const iToU = {"い":"う","き":"く","ぎ":"ぐ","し":"す","ち":"つ","に":"ぬ","び":"ぶ","み":"む","り":"る"};
  const aToU = {"わ":"う","か":"く","が":"ぐ","さ":"す","た":"つ","な":"ぬ","ば":"ぶ","ま":"む","ら":"る"};
  const godanFromI = (stem)=>{ const last = stem[stem.length-1]; return iToU[last]? stem.slice(0,-1)+iToU[last] : null; };
  const godanFromA = (stem)=>{ const last = stem[stem.length-1]; return aToU[last]? stem.slice(0,-1)+aToU[last] : null; };

  // Bảng quy tắc: mỗi mục = [hậu tố, hàm tạo danh sách ứng viên từ gốc (stem)]
  // Áp dụng nguyên tắc "hậu tố dài nhất khớp thì thắng" để tránh các hậu tố ngắn
  // (như した/です) khớp chồng nhầm lên hậu tố dài hơn chứa nó (như ました/でした).
  const RULES = [
    ["しています", stem=>[stem+"する"]],
    ["していました", stem=>[stem+"する"]],
    ["している", stem=>[stem+"する"]],
    ["していた", stem=>[stem+"する"]],
    ["っています", stem=>["う","つ","る"].map(e=>stem+e)],
    ["っていました", stem=>["う","つ","る"].map(e=>stem+e)],
    ["っている", stem=>["う","つ","る"].map(e=>stem+e)],
    ["っていた", stem=>["う","つ","る"].map(e=>stem+e)],
    ["いています", stem=>[stem+"く"]],
    ["いていました", stem=>[stem+"く"]],
    ["いている", stem=>[stem+"く"]],
    ["いていた", stem=>[stem+"く"]],
    ["いでいます", stem=>[stem+"ぐ"]],
    ["いでいました", stem=>[stem+"ぐ"]],
    ["いでいる", stem=>[stem+"ぐ"]],
    ["いでいた", stem=>[stem+"ぐ"]],
    ["きています", stem=>[stem+"くる"]],
    ["きていました", stem=>[stem+"くる"]],
    ["きている", stem=>[stem+"くる"]],
    ["きていた", stem=>[stem+"くる"]],
    ["んでいます", stem=>["む","ぬ","ぶ"].map(e=>stem+e)],
    ["んでいました", stem=>["む","ぬ","ぶ"].map(e=>stem+e)],
    ["んでいる", stem=>["む","ぬ","ぶ"].map(e=>stem+e)],
    ["んでいた", stem=>["む","ぬ","ぶ"].map(e=>stem+e)],
    ["ませんでした", stem=>[stem+"る", stem+"する", godanFromI(stem)].filter(Boolean)],
    ["ましょう", stem=>[stem+"る", stem+"する", godanFromI(stem)].filter(Boolean)],
    ["ました", stem=>[stem+"る", stem+"する", godanFromI(stem)].filter(Boolean)],
    ["ません", stem=>[stem+"る", stem+"する", godanFromI(stem)].filter(Boolean)],
    ["ます", stem=>[stem+"る", stem+"する", godanFromI(stem)].filter(Boolean)],
    ["なかった", stem=>[stem+"る", godanFromA(stem)].filter(Boolean)],
    ["なければ", stem=>[stem+"る", godanFromA(stem)].filter(Boolean)],
    ["ない", stem=>[stem+"る", godanFromA(stem)].filter(Boolean)],
    ["たかった", stem=>[stem+"る", godanFromI(stem)].filter(Boolean)],
    ["たくなかった", stem=>[stem+"る", godanFromI(stem)].filter(Boolean)],
    ["たくない", stem=>[stem+"る", godanFromI(stem)].filter(Boolean)],
    ["たい", stem=>[stem+"る", godanFromI(stem)].filter(Boolean)],
    ["って", stem=>["う","つ","る"].map(e=>stem+e)],
    ["った", stem=>["う","つ","る"].map(e=>stem+e)],
    ["いて", stem=>[stem+"く"]],
    ["いた", stem=>[stem+"く"]],
    ["いで", stem=>[stem+"ぐ"]],
    ["いだ", stem=>[stem+"ぐ"]],
    ["きて", stem=>[stem+"くる"]],
    ["きた", stem=>[stem+"くる"]],
    ["んで", stem=>["む","ぬ","ぶ"].map(e=>stem+e)],
    ["んだ", stem=>["む","ぬ","ぶ"].map(e=>stem+e)],
    ["して", stem=>stem? [stem+"する", stem+"す"] : [stem+"する"]],
    ["した", stem=>stem? [stem+"する", stem+"す"] : [stem+"する"]],
    ["かった", stem=>[stem+"い"]],
    ["くなかった", stem=>[stem+"い"]],
    ["くない", stem=>[stem+"い"]],
    ["ければ", stem=>[stem+"い"]],
    ["すぎる", stem=>[stem+"い", stem+"る"]],
    ["くて", stem=>[stem+"い"]],
    ["でした", stem=>[stem]],
    ["じゃない", stem=>[stem]],
    ["だった", stem=>[stem]],
    ["です", stem=>[stem]],
  ];

  // tìm hậu tố khớp DÀI NHẤT, chỉ dùng các quy tắc có cùng độ dài lớn nhất đó
  let bestLen = 0, matches = [];
  for(const [suffix, fn] of RULES){
    if(word.endsWith(suffix)){
      if(suffix.length > bestLen){ bestLen = suffix.length; matches = [[suffix, fn]]; }
      else if(suffix.length === bestLen){ matches.push([suffix, fn]); }
    }
  }
  const cands = new Set([word]);
  for(const [suffix, fn] of matches){
    const stem = word.slice(0, word.length - suffix.length);
    fn(stem).forEach(c=>{ if(c) cands.add(c); });
  }
  return [...cands];
}

let _vocabIndexCache = null, _vocabIndexKey = null;
function getVocabIndex(){
  const key = state.customVocab.length; // đơn giản: invalidate khi số từ tự thêm thay đổi
  if(_vocabIndexCache && _vocabIndexKey===key) return _vocabIndexCache;
  const idx = new Map();
  allVocab().forEach(v=>{
    if(v.kanji) { if(!idx.has(v.kanji)) idx.set(v.kanji, v); }
    if(v.hira) { if(!idx.has(v.hira)) idx.set(v.hira, v); }
  });
  _vocabIndexCache = idx; _vocabIndexKey = key;
  return idx;
}

function translateJPtoVI(text){
  const idx = getVocabIndex();
  const chars = Array.from(text);
  let parts = []; let i = 0;
  const MAXLEN = 12;
  const isUsable = (entry, len) => entry && !(len===1 && (!entry.vi || entry.vi.length===0));
  // Kiểm tra tại vị trí i xem có khớp được không (khớp trực tiếp HOẶC qua giải chia),
  // dùng chung cho cả bước tìm từ chính và bước "bỏ qua ký tự chưa nhận diện" —
  // để tránh bỏ lỡ các từ chia thể khi tìm điểm dừng.
  function matchAt(pos){
    for(let len = Math.min(MAXLEN, chars.length-pos); len>=1; len--){
      const chunk = chars.slice(pos, pos+len).join("");
      if(idx.has(chunk) && isUsable(idx.get(chunk), len)) return {len, entry: idx.get(chunk)};
      if(len>=2){
        const cands = deinflectCandidates(chunk);
        for(const c of cands){
          if(c!==chunk && idx.has(c) && isUsable(idx.get(c), len)) return {len, entry: idx.get(c)};
        }
      }
    }
    return null;
  }
  while(i < chars.length){
    const m = matchAt(i);
    if(m){
      parts.push({text: chars.slice(i,i+m.len).join(""), entry: m.entry, found:true});
      i += m.len;
    } else {
      let start = i; i++;
      while(i < chars.length && !matchAt(i)) i++;
      const chunk = chars.slice(start, i).join("");
      if(chunk.trim()) parts.push({text: chunk, entry:null, found:false});
    }
  }
  return parts;
}
function translateVItoJP(text){
  const words = text.toLowerCase().split(/[\s,.!?;]+/).filter(Boolean);
  let parts = [];
  words.forEach(w=>{
    const hit = allVocab().find(v=>v.vi && (v.vi.some(m=>m.toLowerCase()===w) || v.vi.some(m=>m.toLowerCase().includes(w))));
    parts.push({text:w, entry: hit||null, found: !!hit});
  });
  return parts;
}
function findGrammarInSentence(text){
  return allGrammar().filter(g=>{
    const core = g.pattern.replace(/〜/g, "").trim();
    return core.length>=1 && text.includes(core);
  });
}

/* ============ VOCAB LEARNING ============ */
let vocabLevelFilter = "all", vocabTopicFilter = "all";
function renderVocabTopics(){
  const topics = ["all", ...new Set(allVocab().map(v=>v.topic).filter(Boolean))];
  $("#vocabTopicRow").innerHTML = topics.map(t=>`<button class="chip ${t===vocabTopicFilter?'on':''}" data-topic="${t}">${t==="all"?"Tất cả chủ đề":t}</button>`).join("");
  $$("#vocabTopicRow .chip").forEach(c=>c.addEventListener("click",()=>{
    vocabTopicFilter = c.dataset.topic;
    $$("#vocabTopicRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
    renderVocabList();
  }));
}
let vocabPageSize = 60, vocabShown = 60;
function renderVocabList(reset=true){
  if(reset) vocabShown = vocabPageSize;
  let list = allVocab().filter(v=>{
    if(vocabLevelFilter!=="all" && v.level!==vocabLevelFilter) return false;
    if(vocabTopicFilter!=="all" && v.topic!==vocabTopicFilter) return false;
    return true;
  });
  const box = $("#vocabResults");
  if(!list.length){ box.innerHTML = `<div class="empty"><span class="big-ico">🗂</span>Không có từ nào trong bộ lọc này.</div>`; return; }
  const shown = list.slice(0, vocabShown);
  const more = list.length - shown.length;
  box.innerHTML = shown.map(wordCardHTML).join("") +
    (more>0? `<div style="text-align:center;padding:.8rem;"><button class="btn" id="vocabLoadMore">Tải thêm (còn ${more}/${list.length})</button></div>` : `<div class="muted" style="text-align:center;">Đã hiện tất cả ${list.length} từ.</div>`);
  bindWordCardActions(box);
  $("#vocabLoadMore")?.addEventListener("click",()=>{ vocabShown += vocabPageSize; renderVocabList(false); });
}

/* ============ FLASHCARD ============ */
function buildDeck(kind){
  let arr = [];
  if(kind==="favorites") arr = Object.values(state.favorites);
  else if(kind==="mylist") arr = Object.values(state.mylist);
  else if(kind==="custom") arr = state.customVocab;
  else arr = allVocab().filter(v=>v.level===kind);
  return arr;
}
function renderFlashcardArea(kind){
  const deck = buildDeck(kind);
  state.flashcard = {deck, idx:0, flipped:false, kind};
  if(!deck.length){ $("#flashcardArea").innerHTML = `<div class="empty"><span class="big-ico">🎴</span>Bộ này chưa có từ nào. Hãy thêm từ yêu thích hoặc vào danh sách học trước.</div>`; return; }
  paintFlashcard();
}
function paintFlashcard(){
  const {deck, idx, flipped} = state.flashcard;
  const v = deck[idx];
  const key = vkey(v);
  const box = state.fc[key]?.box || 0;
  $("#flashcardArea").innerHTML = `
    <div class="flashcard-wrap">
      <div class="fc-progress">Thẻ ${idx+1} / ${deck.length} · Mức ghi nhớ: ${"★".repeat(box)}${"☆".repeat(4-box)}</div>
      <div class="flashcard" id="fcCard">
        ${flipped? `
          <div class="sub">Nghĩa</div>
          <div style="font-size:1.2rem;margin-top:.4rem;">${v.vi.join("; ")}</div>
          <div class="muted" style="margin-top:.4rem;">${v.hira} · ${v.romaji}</div>
          ${v.examples[0]? `<div class="example" style="margin-top:.6rem;text-align:left;"><div class="jp">${v.examples[0].jp}</div><div>${v.examples[0].vi}</div></div>`:""}
        `:`
          <div class="jp">${v.kanji||v.hira}</div>
          <div class="sub">Chạm để xem nghĩa</div>
        `}
      </div>
      <div class="fc-controls">
        <button class="btn" id="fcSpeak">🔊</button>
        <button class="btn accent" id="fcDontKnow">😵 Chưa nhớ</button>
        <button class="btn primary" id="fcKnow">✅ Đã nhớ</button>
      </div>
    </div>`;
  $("#fcCard").addEventListener("click",()=>{ state.flashcard.flipped = !state.flashcard.flipped; paintFlashcard(); });
  $("#fcSpeak").addEventListener("click",(e)=>{ e.stopPropagation(); speak(v.kanji||v.hira,"ja-JP"); });
  $("#fcKnow").addEventListener("click",(e)=>{ e.stopPropagation(); bumpBox(key,1); nextCard(); });
  $("#fcDontKnow").addEventListener("click",(e)=>{ e.stopPropagation(); bumpBox(key,-1); nextCard(); });
}
function bumpBox(key,delta){
  const cur = state.fc[key]?.box || 0;
  state.fc[key] = {box: Math.max(0, Math.min(4, cur+delta))};
  scheduleSave();
}
function nextCard(){
  const fc = state.flashcard;
  fc.idx = (fc.idx+1) % fc.deck.length;
  fc.flipped = false;
  paintFlashcard();
}

/* ============ JLPT QUIZ ============ */
function shuffle(a){ a = a.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

function buildQuiz(level, type){
  let pool, qs = [];
  if(type==="vocab"){
    pool = allVocab().filter(v=>v.level===level);
    if(pool.length<4) pool = allVocab();
    shuffle(pool).slice(0,10).forEach(v=>{
      const wrongs = shuffle(pool.filter(x=>x!==v)).slice(0,3).map(x=>x.vi[0]);
      const opts = shuffle([v.vi[0], ...wrongs]);
      qs.push({q:`「${v.kanji||v.hira}」(${v.hira}) nghĩa là gì?`, opts, answer:v.vi[0]});
    });
  } else if(type==="kanji"){
    pool = allKanji().filter(k=>k.level===level);
    if(pool.length<4) pool = allKanji();
    shuffle(pool).slice(0,10).forEach(k=>{
      const wrongs = shuffle(pool.filter(x=>x!==k)).slice(0,3).map(x=>x.meaning);
      const opts = shuffle([k.meaning, ...wrongs]);
      qs.push({q:`Kanji 「${k.char}」nghĩa là gì?`, opts, answer:k.meaning});
    });
  } else {
    pool = allGrammar().filter(g=>g.level===level);
    if(pool.length<4) pool = allGrammar();
    shuffle(pool).slice(0,10).forEach(g=>{
      const wrongs = shuffle(pool.filter(x=>x!==g)).slice(0,3).map(x=>x.meaning);
      const opts = shuffle([g.meaning, ...wrongs]);
      qs.push({q:`Mẫu ngữ pháp 「${g.pattern}」nghĩa là gì?`, opts, answer:g.meaning});
    });
  }
  return qs;
}

function startJLPT(){
  const level = $("#jlptLevelRow .chip.on").dataset.lvl;
  const type = $("#jlptTypeRow .chip.on").dataset.type;
  state.jlpt = {level, type, questions:buildQuiz(level,type), idx:0, score:0, active:true};
  paintJLPT();
}
function paintJLPT(){
  const s = state.jlpt;
  if(!s.active){ $("#jlptArea").innerHTML=""; return; }
  if(s.idx >= s.questions.length){
    $("#jlptArea").innerHTML = `<div class="card"><h3>Kết quả</h3><p>Bạn đúng ${s.score}/${s.questions.length} câu (${s.level} · ${s.type}).</p>
      <button class="btn primary" id="jlptRetry">Luyện lại</button></div>`;
    $("#jlptRetry").addEventListener("click", startJLPT);
    return;
  }
  const q = s.questions[s.idx];
  $("#jlptArea").innerHTML = `<div class="card">
    <div class="muted">Câu ${s.idx+1}/${s.questions.length} · Điểm: ${s.score}</div>
    <div class="quiz-q">${q.q}</div>
    ${q.opts.map(o=>`<button class="quiz-opt" data-opt="${escapeAttr(o)}">${o}</button>`).join("")}
  </div>`;
  $$(".quiz-opt", $("#jlptArea")).forEach(btn=>{
    btn.addEventListener("click",()=>{
      $$(".quiz-opt", $("#jlptArea")).forEach(b=>b.disabled=true);
      const chosen = btn.dataset.opt;
      if(chosen===q.answer){ btn.classList.add("correct"); s.score++; }
      else{
        btn.classList.add("wrong");
        $$(".quiz-opt", $("#jlptArea")).forEach(b=>{ if(b.dataset.opt===q.answer) b.classList.add("correct"); });
      }
      setTimeout(()=>{ s.idx++; paintJLPT(); }, 900);
    });
  });
}

/* ============ READING ============ */
function renderReadingList(){
  $("#readingList").innerHTML = READINGS.map((r,i)=>`<button class="chip ${i===state.reading.current?'on':''}" data-i="${i}">${r.level} · ${r.title}</button>`).join("");
  $$("#readingList .chip").forEach(c=>c.addEventListener("click",()=>{ state.reading.current = +c.dataset.i; renderReadingList(); renderReadingArea(); }));
}
function renderReadingArea(){
  const r = READINGS[state.reading.current];
  let html = r.text;
  r.vocab.forEach(w=>{
    html = html.split(w).join(`<span class="tapword" data-w="${w}">${w}</span>`);
  });
  $("#readingArea").innerHTML = `<div class="card">
    <div class="word-title"><h3 style="margin:0;">${r.title}</h3><span class="pill level lvl-${r.level}">${r.level}</span></div>
    <p class="reading-text" style="margin-top:.7rem;">${html}</p>
    <div class="row-actions"><button id="readSpeak">🔊 Đọc toàn bài</button></div>
    <div id="readingWordInfo"></div>
  </div>`;
  $("#readSpeak").addEventListener("click",()=>speak(r.text,"ja-JP"));
  $$(".tapword", $("#readingArea")).forEach(sp=>sp.addEventListener("click",()=>{
    const w = sp.dataset.w;
    const hit = allVocab().find(v=>v.kanji===w || v.hira===w) ;
    const info = $("#readingWordInfo");
    if(hit){ info.innerHTML = wordCardHTML(hit); bindWordCardActions(info); }
    else{ info.innerHTML = `<div class="card"><b>${w}</b> — chưa có trong từ điển mẫu. <button id="rSpeak">🔊</button></div>`;
      $("#rSpeak").addEventListener("click",()=>speak(w,"ja-JP")); }
    logHistory("reading-word", w);
  }));
}

/* ============ MY WORDS (custom vocab from user's own books) ============ */
function addCustomVocab(v){
  // tránh trùng key
  const key = vkey(v);
  state.customVocab = state.customVocab.filter(x=>vkey(x)!==key);
  state.customVocab.push(v);
  scheduleSave();
}
function removeCustomVocab(key){
  state.customVocab = state.customVocab.filter(x=>vkey(x)!==key);
  scheduleSave();
  renderMyWordsList();
}
function parseExampleLines(raw){
  return raw.split("\n").map(l=>l.trim()).filter(Boolean).map(l=>{
    const [jp, vi] = l.split("—").map(s=>s? s.trim(): "");
    return {jp: jp||l, romaji:"", vi: vi||""};
  });
}
function renderMyWordsList(){
  const box = $("#mywordsList");
  if(!state.customVocab.length){ box.innerHTML = `<div class="empty"><span class="big-ico">➕</span>Bạn chưa thêm từ nào. Dùng form phía trên để bắt đầu.</div>`; return; }
  box.innerHTML = state.customVocab.slice().reverse().map(v=>{
    const key = vkey(v);
    return `<div class="card" data-mwkey="${escapeAttr(key)}">
      <div class="word-title"><span class="jp">${v.kanji||v.hira}</span><span class="kana">${v.hira}</span><span class="romaji">${v.romaji}</span>
        <span class="pill">${v.level||"Từ tự thêm"}</span></div>
      <div><b>Nghĩa:</b> ${v.vi.join("; ")}</div>
      ${v.examples.map(ex=>`<div class="example"><div class="jp">${ex.jp}</div><div>${ex.vi}</div></div>`).join("")}
      <div class="row-actions">
        <button class="act-speak">🔊 Phát âm</button>
        <button class="act-del">🗑 Xóa</button>
      </div>
    </div>`;
  }).join("");
  $$("[data-mwkey]", box).forEach(card=>{
    const key = card.dataset.mwkey;
    $(".act-speak",card)?.addEventListener("click",()=>{
      const v = state.customVocab.find(x=>vkey(x)===key);
      speak(v.kanji||v.hira,"ja-JP");
    });
    $(".act-del",card)?.addEventListener("click",()=>{ if(confirm("Xóa từ này?")) removeCustomVocab(key); });
  });
}
function setupMyWords(){
  $("#mwAddBtn").addEventListener("click",()=>{
    const kanji = $("#mwKanji").value.trim();
    const hira = $("#mwHira").value.trim();
    const romaji = $("#mwRomaji").value.trim();
    const level = $("#mwLevel").value.trim() || "Từ tự thêm";
    const viRaw = $("#mwVi").value.trim();
    const exRaw = $("#mwExample").value.trim();
    if(!kanji && !hira){ toast("Cần nhập ít nhất Kanji hoặc Hiragana."); return; }
    if(!viRaw){ toast("Cần nhập nghĩa tiếng Việt."); return; }
    const v = {
      kanji, hira, kata:"", romaji, pos:"", level, topic:"Từ tự thêm",
      vi: viRaw.split(";").map(s=>s.trim()).filter(Boolean),
      en: [], jp: "",
      examples: exRaw? parseExampleLines(exRaw) : [],
      synonyms: [], compounds: []
    };
    addCustomVocab(v);
    ["#mwKanji","#mwHira","#mwRomaji","#mwLevel","#mwVi","#mwExample"].forEach(id=>$(id).value="");
    renderMyWordsList();
    toast("Đã lưu từ mới!");
  });
  $("#mwClearForm").addEventListener("click",()=>{
    ["#mwKanji","#mwHira","#mwRomaji","#mwLevel","#mwVi","#mwExample"].forEach(id=>$(id).value="");
  });
  $("#mwBulkBtn").addEventListener("click",()=>{
    const raw = $("#mwBulk").value.trim();
    if(!raw){ return; }
    const lines = raw.split("\n").map(l=>l.trim()).filter(Boolean);
    let count = 0, errors = 0;
    lines.forEach(line=>{
      const parts = line.split("|").map(s=>s.trim());
      if(parts.length<4){ errors++; return; }
      const [kanji, hira, romaji, viRaw, level] = parts;
      if(!viRaw){ errors++; return; }
      addCustomVocab({
        kanji, hira, kata:"", romaji: romaji||"", pos:"", level: level||"Từ tự thêm", topic:"Từ tự thêm",
        vi: viRaw.split(";").map(s=>s.trim()).filter(Boolean), en:[], jp:"", examples:[], synonyms:[], compounds:[]
      });
      count++;
    });
    $("#mwBulk").value = "";
    $("#mwBulkResult").textContent = `Đã nhập ${count} từ thành công${errors? `, ${errors} dòng lỗi định dạng (bỏ qua)`:""}.`;
    renderMyWordsList();
  });
}

function gkey(g){ return g.pattern; }
function addCustomGrammar(g){
  const key = gkey(g);
  state.customGrammar = state.customGrammar.filter(x=>gkey(x)!==key);
  state.customGrammar.push(g);
  scheduleSave();
}
function removeCustomGrammar(key){
  state.customGrammar = state.customGrammar.filter(x=>gkey(x)!==key);
  scheduleSave();
  renderMyGrammarList();
}
function renderMyGrammarList(){
  const box = $("#mygrammarList");
  if(!state.customGrammar.length){ box.innerHTML = `<div class="empty"><span class="big-ico">➕</span>Bạn chưa thêm mẫu ngữ pháp nào.</div>`; return; }
  box.innerHTML = state.customGrammar.slice().reverse().map(g=>{
    const key = gkey(g);
    return `<div class="card" data-mgkey="${escapeAttr(key)}">
      <div class="word-title"><span class="jp" style="font-size:1.2rem;">${g.pattern}</span><span class="pill">${g.level||"Tự thêm"}</span></div>
      <div style="margin-top:.3rem;"><b>Ý nghĩa:</b> ${g.meaning}</div>
      ${g.structure? `<div><b>Cấu trúc:</b> ${g.structure}</div>`:""}
      ${g.usage? `<div><b>Cách dùng:</b> ${g.usage}</div>`:""}
      ${g.examples.map(ex=>`<div class="example"><div class="jp">${ex.jp}</div><div>${ex.vi}</div></div>`).join("")}
      <div class="row-actions"><button class="act-del">🗑 Xóa</button></div>
    </div>`;
  }).join("");
  $$("[data-mgkey]", box).forEach(card=>{
    $(".act-del",card)?.addEventListener("click",()=>{ if(confirm("Xóa mẫu ngữ pháp này?")) removeCustomGrammar(card.dataset.mgkey); });
  });
}
function setupMyGrammar(){
  $("#mgAddBtn").addEventListener("click",()=>{
    const pattern = $("#mgPattern").value.trim();
    const meaning = $("#mgMeaning").value.trim();
    const structure = $("#mgStructure").value.trim();
    const usage = $("#mgUsage").value.trim();
    const level = $("#mgLevel").value.trim() || "Tự thêm";
    const exRaw = $("#mgExample").value.trim();
    if(!pattern || !meaning){ toast("Cần nhập ít nhất Mẫu ngữ pháp và Ý nghĩa."); return; }
    addCustomGrammar({
      pattern, meaning, structure, usage, level,
      examples: exRaw? parseExampleLines(exRaw) : []
    });
    ["#mgPattern","#mgLevel","#mgMeaning","#mgStructure","#mgUsage","#mgExample"].forEach(id=>$(id).value="");
    renderMyGrammarList();
    toast("Đã lưu mẫu ngữ pháp mới!");
  });
  $("#mgClearForm").addEventListener("click",()=>{
    ["#mgPattern","#mgLevel","#mgMeaning","#mgStructure","#mgUsage","#mgExample"].forEach(id=>$(id).value="");
  });
  $("#mgBulkBtn").addEventListener("click",()=>{
    const raw = $("#mgBulk").value.trim();
    if(!raw) return;
    const lines = raw.split("\n").map(l=>l.trim()).filter(Boolean);
    let count = 0, errors = 0;
    lines.forEach(line=>{
      const parts = line.split("|").map(s=>s.trim());
      if(parts.length<2){ errors++; return; }
      const [pattern, meaning, structure, usage, level] = parts;
      if(!pattern || !meaning){ errors++; return; }
      addCustomGrammar({ pattern, meaning, structure: structure||"", usage: usage||"", level: level||"Tự thêm", examples: [] });
      count++;
    });
    $("#mgBulk").value = "";
    $("#mgBulkResult").textContent = `Đã nhập ${count} mẫu thành công${errors? `, ${errors} dòng lỗi định dạng (bỏ qua)`:""}.`;
    renderMyGrammarList();
  });
  // sub-tab toggle
  $$("#mwTypeRow .chip").forEach(c=>c.addEventListener("click",()=>{
    $$("#mwTypeRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
    const isVocab = c.dataset.mwtype==="vocab";
    $("#mwVocabPane").classList.toggle("hidden", !isVocab);
    $("#mwGrammarPane").classList.toggle("hidden", isVocab);
  }));
}

/* ============ TOOLS (Công cụ) ============ */
const TOOLS_FIELDS = [
  {key:"kanji", label:"Kanji/chữ viết"},
  {key:"hira", label:"Hiragana"},
  {key:"romaji", label:"Romaji"},
  {key:"vi", label:"Nghĩa VI (cách nhau bởi ;)"},
  {key:"level", label:"Cấp độ/Nguồn"},
  {key:"pos", label:"Loại từ"},
];
const TOOLS_FIELDS_KANJI = [
  {key:"char", label:"Kanji"},
  {key:"meaning", label:"Nghĩa"},
  {key:"onyomi", label:"On'yomi (cách nhau ,)"},
  {key:"kunyomi", label:"Kun'yomi (cách nhau ,)"},
  {key:"level", label:"Cấp độ"},
];
let csvParsed = null; // {headers, rows}
let toolsEditType = "vocab";

function parseCSV(text){
  // Basic CSV parser supporting quoted fields and commas within quotes
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i], next = text[i+1];
    if(inQuotes){
      if(c === '"' && next === '"'){ field += '"'; i++; }
      else if(c === '"'){ inQuotes = false; }
      else field += c;
    } else {
      if(c === '"'){ inQuotes = true; }
      else if(c === ','){ row.push(field); field=""; }
      else if(c === '\n'){ row.push(field); rows.push(row); row=[]; field=""; }
      else if(c === '\r'){ /* skip */ }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  const filtered = rows.filter(r=>r.some(c=>c && c.trim()));
  return { headers: filtered[0]||[], rows: filtered.slice(1) };
}

function setupCSVImport(){
  const zone = $("#csvDropZone"), input = $("#csvFileInput");
  zone.addEventListener("click",()=>input.click());
  zone.addEventListener("dragover",(e)=>{ e.preventDefault(); zone.style.borderColor="var(--indigo)"; });
  zone.addEventListener("dragleave",()=>{ zone.style.borderColor="var(--line)"; });
  zone.addEventListener("drop",(e)=>{
    e.preventDefault(); zone.style.borderColor="var(--line)";
    const file = e.dataTransfer.files[0];
    if(file) handleCSVFile(file);
  });
  input.addEventListener("change",()=>{ if(input.files[0]) handleCSVFile(input.files[0]); });

  $("#csvTargetType").addEventListener("change", renderCSVMapRow);
  $("#csvPreviewBtn").addEventListener("click", renderCSVPreview);
  $("#csvImportBtn").addEventListener("click", doCSVImport);
}
function handleCSVFile(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    csvParsed = parseCSV(reader.result);
    if(!csvParsed.headers.length){ toast("Không đọc được file CSV."); return; }
    $("#csvMapCard").classList.remove("hidden");
    $("#csvPreviewCard").classList.add("hidden");
    renderCSVMapRow();
    toast(`Đã đọc ${csvParsed.rows.length} dòng từ file.`);
  };
  reader.readAsText(file, "UTF-8");
}
function renderCSVMapRow(){
  if(!csvParsed) return;
  const targetType = $("#csvTargetType").value;
  const fields = targetType==="vocab"? TOOLS_FIELDS : TOOLS_FIELDS_KANJI;
  const headers = csvParsed.headers;
  $("#csvMapRow").innerHTML = fields.map(f=>{
    // auto-guess matching column by name similarity
    let guessIdx = headers.findIndex(h=>h.toLowerCase().includes(f.key.toLowerCase()) || (f.key==="hira" && h.toLowerCase().includes("reading")) || (f.key==="char" && h.toLowerCase().includes("kanji")));
    return `<div>
      <label style="font-size:.8rem;" class="muted">${f.label}</label>
      <select data-field="${f.key}" style="width:100%;padding:.5rem;border:1px solid var(--line);border-radius:8px;background:var(--card);">
        <option value="">— Không dùng —</option>
        ${headers.map((h,i)=>`<option value="${i}" ${i===guessIdx?'selected':''}>${escapeHtml(h)}</option>`).join("")}
      </select>
    </div>`;
  }).join("");
}
function renderCSVPreview(){
  if(!csvParsed) return;
  const targetType = $("#csvTargetType").value;
  const mapping = {};
  $$("#csvMapRow select").forEach(sel=>{ if(sel.value!=="") mapping[sel.dataset.field] = parseInt(sel.value); });
  if(mapping.kanji===undefined && mapping.char===undefined){ toast("Cần chọn ít nhất cột Kanji."); return; }

  const preview = csvParsed.rows.slice(0,10).map(row=>buildEntryFromRow(row, mapping, targetType));
  const fields = targetType==="vocab"? TOOLS_FIELDS : TOOLS_FIELDS_KANJI;
  const table = $("#csvPreviewTable");
  table.innerHTML = "<tr>"+fields.map(f=>`<th style="text-align:left;padding:.3rem;border-bottom:1px solid var(--line);">${f.label}</th>`).join("")+"</tr>"+
    preview.map(e=>"<tr>"+fields.map(f=>{
      let v = e[f.key==="char"?"char":f.key];
      if(Array.isArray(v)) v = v.join(", ");
      return `<td style="padding:.3rem;border-bottom:1px solid var(--line);">${escapeHtml(String(v||""))}</td>`;
    }).join("")+"</tr>").join("");
  $("#csvPreviewCard").classList.remove("hidden");
  $("#csvPreviewSummary").textContent = `Tổng cộng ${csvParsed.rows.length} dòng sẽ được nhập vào ${targetType==="vocab"?"Từ vựng":"Kanji"}.`;
  csvParsed._mapping = mapping;
  csvParsed._targetType = targetType;
}
function buildEntryFromRow(row, mapping, targetType){
  const get = (k)=> mapping[k]!==undefined? (row[mapping[k]]||"").trim() : "";
  if(targetType==="vocab"){
    return {
      kanji: get("kanji"), hira: get("hira"), kata:"", romaji: get("romaji"),
      pos: get("pos"), level: get("level")||"Nhập CSV", topic:"Nhập từ CSV",
      vi: get("vi")? get("vi").split(";").map(s=>s.trim()).filter(Boolean) : [],
      en:[], jp:"", examples:[], synonyms:[], compounds:[], imported:true
    };
  } else {
    return {
      char: get("char"), meaning: get("meaning"),
      onyomi: get("onyomi")? get("onyomi").split(",").map(s=>s.trim()).filter(Boolean):[],
      kunyomi: get("kunyomi")? get("kunyomi").split(",").map(s=>s.trim()).filter(Boolean):[],
      level: get("level")||"Nhập CSV", strokes:0, radical:"", compounds:[], imported:true
    };
  }
}
function doCSVImport(){
  if(!csvParsed || !csvParsed._mapping) return;
  const { _mapping: mapping, _targetType: targetType, rows } = csvParsed;
  let count = 0;
  rows.forEach(row=>{
    const entry = buildEntryFromRow(row, mapping, targetType);
    if(targetType==="vocab"){
      if(!entry.kanji && !entry.hira) return;
      addCustomVocab(entry); count++;
    } else {
      if(!entry.char) return;
      addCustomKanji(entry); count++;
    }
  });
  $("#csvImportResult").textContent = `✅ Đã thêm ${count} mục vào ${targetType==="vocab"?"Từ vựng":"Kanji"}. Bạn có thể vào "Sửa trực tiếp" để bổ sung thêm chi tiết.`;
  toast(`Đã nhập ${count} mục thành công!`);
}

/* -- custom kanji management (mirrors custom vocab) -- */
function addCustomKanji(k){
  const key = k.char;
  state.customKanji = state.customKanji.filter(x=>x.char!==key);
  state.customKanji.push(k);
  scheduleSave();
}

/* -- Edit table -- */
let editShown = 40;
function renderEditTable(){
  const q = normalize($("#editSearchInput").value);
  const box = $("#editTableArea");
  if(toolsEditType==="vocab"){
    let list = [...state.customVocab, ...(typeof IMPORTED_VOCAB!=="undefined"?IMPORTED_VOCAB:[])];
    if(q) list = list.filter(v=>normalize(v.kanji).includes(q)||normalize(v.hira).includes(q));
    const shown = list.slice(0, editShown);
    box.innerHTML = shown.map(v=>{
      const key = vkey(v);
      return `<div class="card" data-editkey="${escapeAttr(key)}">
        <div class="two-col">
          <input data-f="kanji" value="${escapeAttr(v.kanji)}" placeholder="Kanji">
          <input data-f="hira" value="${escapeAttr(v.hira)}" placeholder="Hiragana">
          <input data-f="romaji" value="${escapeAttr(v.romaji||"")}" placeholder="Romaji">
          <input data-f="level" value="${escapeAttr(v.level||"")}" placeholder="Cấp độ">
        </div>
        <input data-f="vi" value="${escapeAttr((v.vi||[]).join('; '))}" placeholder="Nghĩa VI (cách nhau ;)" style="width:100%;margin-top:.4rem;padding:.5rem;border:1px solid var(--line);border-radius:8px;background:var(--card);">
        <div class="row-actions"><button class="edit-save">💾 Lưu</button><button class="edit-del">🗑 Xóa</button></div>
      </div>`;
    }).join("") + (list.length>shown.length? `<div style="text-align:center;"><button class="btn" id="editLoadMore">Tải thêm</button></div>`:"");
  } else {
    let list = [...state.customKanji, ...(typeof IMPORTED_KANJI!=="undefined"?IMPORTED_KANJI:[])];
    if(q) list = list.filter(k=>k.char.includes(q));
    const shown = list.slice(0, editShown);
    box.innerHTML = shown.map(k=>{
      return `<div class="card" data-editkey="${escapeAttr(k.char)}">
        <div class="two-col">
          <input data-f="char" value="${escapeAttr(k.char)}" placeholder="Kanji">
          <input data-f="meaning" value="${escapeAttr(k.meaning||"")}" placeholder="Nghĩa">
          <input data-f="onyomi" value="${escapeAttr((k.onyomi||[]).join(', '))}" placeholder="On'yomi">
          <input data-f="kunyomi" value="${escapeAttr((k.kunyomi||[]).join(', '))}" placeholder="Kun'yomi">
        </div>
        <div class="row-actions"><button class="edit-save">💾 Lưu</button><button class="edit-del">🗑 Xóa</button></div>
      </div>`;
    }).join("") + (list.length>shown.length? `<div style="text-align:center;"><button class="btn" id="editLoadMore">Tải thêm</button></div>`:"");
  }
  $$("[data-editkey]", box).forEach(card=>{
    const origKey = card.dataset.editkey;
    $(".edit-save",card)?.addEventListener("click",()=>{
      if(toolsEditType==="vocab"){
        const entry = {
          kanji: $('[data-f=kanji]',card).value.trim(), hira: $('[data-f=hira]',card).value.trim(),
          kata:"", romaji: $('[data-f=romaji]',card).value.trim(), pos:"",
          level: $('[data-f=level]',card).value.trim()||"Nhập CSV", topic:"Nhập từ CSV",
          vi: $('[data-f=vi]',card).value.split(";").map(s=>s.trim()).filter(Boolean),
          en:[], jp:"", examples:[], synonyms:[], compounds:[], imported:true
        };
        // remove any old entry with the original key first (in case kanji/hira changed)
        state.customVocab = state.customVocab.filter(x=>vkey(x)!==origKey);
        addCustomVocab(entry);
      } else {
        const entry = {
          char: $('[data-f=char]',card).value.trim(), meaning: $('[data-f=meaning]',card).value.trim(),
          onyomi: $('[data-f=onyomi]',card).value.split(",").map(s=>s.trim()).filter(Boolean),
          kunyomi: $('[data-f=kunyomi]',card).value.split(",").map(s=>s.trim()).filter(Boolean),
          level:"Nhập CSV", strokes:0, radical:"", compounds:[], imported:true
        };
        state.customKanji = state.customKanji.filter(x=>x.char!==origKey);
        addCustomKanji(entry);
      }
      toast("Đã lưu thay đổi!");
      renderEditTable();
    });
    $(".edit-del",card)?.addEventListener("click",()=>{
      if(!confirm("Xóa mục này?")) return;
      if(toolsEditType==="vocab") state.customVocab = state.customVocab.filter(x=>vkey(x)!==origKey);
      else state.customKanji = state.customKanji.filter(x=>x.char!==origKey);
      scheduleSave();
      renderEditTable();
    });
  });
  $("#editLoadMore")?.addEventListener("click",()=>{ editShown += 40; renderEditTable(); });
}

/* -- Duplicate finder -- */
function scanDuplicates(){
  const box = $("#dupResultArea");
  const vmap = {};
  allVocab().forEach(v=>{ const k=vkey(v); (vmap[k]=vmap[k]||[]).push(v); });
  const vdups = Object.entries(vmap).filter(([k,arr])=>arr.length>1);
  const kmap = {};
  allKanji().forEach(k=>{ (kmap[k.char]=kmap[k.char]||[]).push(k); });
  const kdups = Object.entries(kmap).filter(([k,arr])=>arr.length>1);

  if(!vdups.length && !kdups.length){ box.innerHTML = `<div class="empty"><span class="big-ico">✅</span>Không tìm thấy từ/kanji trùng lặp.</div>`; return; }
  let html = "";
  if(vdups.length) html += `<div class="card"><b>Từ vựng trùng (${vdups.length}):</b>` +
    vdups.slice(0,100).map(([k,arr])=>`<div class="example">${arr[0].kanji||arr[0].hira} (${arr[0].hira}) — xuất hiện ${arr.length} lần</div>`).join("") + `</div>`;
  if(kdups.length) html += `<div class="card"><b>Kanji trùng (${kdups.length}):</b>` +
    kdups.slice(0,100).map(([k,arr])=>`<div class="example">${k} — xuất hiện ${arr.length} lần</div>`).join("") + `</div>`;
  box.innerHTML = html;
}

/* -- Error checker -- */
function scanErrors(){
  const box = $("#errResultArea");
  const noMeaningVocab = allVocab().filter(v=>!v.vi || v.vi.length===0);
  const noMeaningKanji = allKanji().filter(k=>!k.meaning);
  const noReadingVocab = allVocab().filter(v=>!v.hira);
  let html = `<div class="card">
    <div>📖 Từ vựng thiếu nghĩa: <b>${noMeaningVocab.length}</b></div>
    <div>📖 Từ vựng thiếu cách đọc: <b>${noReadingVocab.length}</b></div>
    <div>漢 Kanji thiếu nghĩa: <b>${noMeaningKanji.length}</b></div>
  </div>`;
  if(noMeaningVocab.length){
    html += `<div class="card"><b>Ví dụ từ thiếu nghĩa (20 đầu):</b>` +
      noMeaningVocab.slice(0,20).map(v=>`<span class="pill" style="margin:.15rem;">${v.kanji||v.hira}</span>`).join("") +
      `<p class="muted" style="font-size:.8rem;margin-top:.4rem;">Vào "Sửa trực tiếp" để bổ sung nghĩa cho các từ này.</p></div>`;
  }
  box.innerHTML = html;
}

/* -- Export data.js -- */
function exportDataJs(){
  const lines = [];
  lines.push("// NionVN — dữ liệu tự thêm/nhập, xuất ngày " + new Date().toLocaleString("vi-VN"));
  lines.push("const CUSTOM_VOCAB_EXPORT = " + JSON.stringify(state.customVocab, null, 1) + ";");
  lines.push("const CUSTOM_GRAMMAR_EXPORT = " + JSON.stringify(state.customGrammar, null, 1) + ";");
  lines.push("const CUSTOM_KANJI_EXPORT = " + JSON.stringify(state.customKanji, null, 1) + ";");
  const blob = new Blob([lines.join("\n\n")], {type:"application/javascript"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download="data-custom.js"; a.click();
  URL.revokeObjectURL(url);
  toast("Đã xuất data-custom.js");
}

/* -- GitHub sync (Contents API, client-side only, uses user's own PAT) -- */
async function githubSync(){
  const owner = $("#ghOwner").value.trim();
  const repo = $("#ghRepo").value.trim();
  const path = $("#ghPath").value.trim() || "data-custom.js";
  const token = $("#ghToken").value.trim();
  const resultEl = $("#ghSyncResult");
  if(!owner || !repo || !token){ resultEl.textContent = "Vui lòng nhập đủ tên tài khoản, repo và token."; return; }

  const content = [
    "// NionVN — đồng bộ từ trình duyệt, " + new Date().toLocaleString("vi-VN"),
    "const CUSTOM_VOCAB_EXPORT = " + JSON.stringify(state.customVocab) + ";",
    "const CUSTOM_GRAMMAR_EXPORT = " + JSON.stringify(state.customGrammar) + ";",
    "const CUSTOM_KANJI_EXPORT = " + JSON.stringify(state.customKanji) + ";"
  ].join("\n");

  resultEl.textContent = "Đang đồng bộ...";
  try{
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    // Step 1: check if file exists to get its sha (needed to update)
    let sha = undefined;
    const getRes = await fetch(apiUrl, { headers: { "Authorization": `token ${token}` } });
    if(getRes.status===200){ const j = await getRes.json(); sha = j.sha; }

    const b64 = btoa(unescape(encodeURIComponent(content)));
    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: { "Authorization": `token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "NionVN: đồng bộ dữ liệu tự thêm từ trình duyệt",
        content: b64,
        sha: sha
      })
    });
    if(putRes.status===200 || putRes.status===201){
      resultEl.textContent = `✅ Đồng bộ thành công lên ${owner}/${repo}/${path}!`;
      toast("Đồng bộ GitHub thành công!");
    } else {
      const errJson = await putRes.json().catch(()=>({}));
      resultEl.textContent = `❌ Lỗi (${putRes.status}): ${errJson.message||"không xác định"}. Kiểm tra lại tên tài khoản/repo/token.`;
    }
  }catch(e){
    resultEl.textContent = "❌ Lỗi kết nối: " + e.message;
  }
}

function renderToolsHome(){
  // called when Tools tab opens; nothing heavy needed by default
}
function openEditTableFor(type, key){
  toolsEditType = type;
  $$("#tools-edit [data-etype]").forEach(c=>c.classList.toggle("on", c.dataset.etype===type));
  $("#editSearchInput").value = type==="kanji"? key : key.split("|")[0];
  renderEditTable();
}
window.editVocabPrompt = (key)=>{ showView("tools"); $$("#toolsSubRow .chip").forEach(c=>c.classList.toggle("on", c.dataset.tsub==="edit")); $$(".tools-pane").forEach(p=>p.classList.add("hidden")); $("#tools-edit").classList.remove("hidden"); openEditTableFor("vocab", key); };

function setupTools(){
  setupCSVImport();
  $$("#toolsSubRow .chip").forEach(c=>c.addEventListener("click",()=>{
    $$("#toolsSubRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
    $$(".tools-pane").forEach(p=>p.classList.add("hidden"));
    $("#tools-"+c.dataset.tsub).classList.remove("hidden");
  }));
  $$("#tools-edit [data-etype]").forEach(c=>c.addEventListener("click",()=>{
    $$("#tools-edit [data-etype]").forEach(x=>x.classList.remove("on")); c.classList.add("on");
    toolsEditType = c.dataset.etype; editShown = 40; renderEditTable();
  }));
  $("#editSearchInput").addEventListener("input",()=>{ editShown=40; renderEditTable(); });
  $("#dupScanBtn").addEventListener("click", scanDuplicates);
  $("#errScanBtn").addEventListener("click", scanErrors);
  $("#exportDataJsBtn").addEventListener("click", exportDataJs);
  $("#ghSyncBtn").addEventListener("click", githubSync);
}

/* ============ ME / HISTORY ============ */
let meTab = "history";
function renderMe(){
  const box = $("#meArea");
  if(meTab==="history"){
    box.innerHTML = state.history.length? `<div class="card">${state.history.slice(0,80).map(h=>`<div style="padding:.35rem 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;">
      <span>${h.type==='dict'?'📖':h.type==='kanji'?'漢':'📰'} ${h.label}</span><span class="muted" style="font-size:.75rem;">${new Date(h.ts).toLocaleString('vi-VN')}</span></div>`).join("")}
      <div class="row-actions" style="margin-top:.6rem;"><button id="clearHistory">🗑 Xóa lịch sử</button></div></div>`
      : `<div class="empty"><span class="big-ico">🕘</span>Chưa có lịch sử tra cứu.</div>`;
    $("#clearHistory")?.addEventListener("click",()=>{ state.history=[]; renderMe(); toast("Đã xóa lịch sử."); });
  } else if(meTab==="favorites"){
    const arr = Object.values(state.favorites);
    box.innerHTML = arr.length? arr.map(wordCardHTML).join("") : `<div class="empty"><span class="big-ico">⭐</span>Chưa có từ yêu thích nào.</div>`;
    bindWordCardActions(box);
  } else if(meTab==="mylist"){
    const arr = Object.values(state.mylist);
    box.innerHTML = arr.length? arr.map(wordCardHTML).join("") : `<div class="empty"><span class="big-ico">🗂</span>Danh sách học của bạn đang trống.</div>`;
    bindWordCardActions(box);
  } else if(meTab==="notes"){
    const entries = Object.entries(state.notes).filter(([k,v])=>v && v.trim());
    box.innerHTML = entries.length? entries.map(([k,v])=>{
      const w = allVocab().find(x=>vkey(x)===k);
      return `<div class="card"><b>${w? (w.kanji||w.hira) : k}</b><p>${escapeHtml(v)}</p></div>`;
    }).join("") : `<div class="empty"><span class="big-ico">📝</span>Chưa có ghi chú nào. Bạn có thể thêm ghi chú ngay dưới mỗi từ trong Từ điển.</div>`;
  }
}

/* ============ SETTINGS / EXPORT / IMPORT ============ */
function applySettings(){
  document.body.setAttribute("data-theme", state.settings.theme);
  document.documentElement.style.setProperty("--fs", state.settings.bigfont? "19px":"16px");
  $("#themeToggle").textContent = state.settings.theme==="dark"? "☀️":"🌙";
  $("#setDark").checked = state.settings.theme==="dark";
  $("#setBigFont").checked = state.settings.bigfont;
  $("#setLang").value = state.settings.lang;
  $("#langToggle").textContent = state.settings.lang.toUpperCase();
  scheduleSave();
}
function exportData(){
  const payload = {favorites:state.favorites, mylist:state.mylist, notes:state.notes, fc:state.fc, history:state.history, settings:state.settings, customVocab:state.customVocab, customGrammar:state.customGrammar, customKanji:state.customKanji};
  const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "nionvn-data.json"; a.click();
  URL.revokeObjectURL(url);
  toast("Đã xuất dữ liệu.");
}
function importData(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      state.favorites = data.favorites || {};
      state.mylist = data.mylist || {};
      state.notes = data.notes || {};
      state.fc = data.fc || {};
      state.history = data.history || [];
      state.customVocab = data.customVocab || [];
      state.customGrammar = data.customGrammar || [];
      state.customKanji = data.customKanji || [];
      state.settings = Object.assign(state.settings, data.settings||{});
      saveToStorage();
      applySettings(); renderMe(); renderMyWordsList(); renderMyGrammarList(); toast("Đã nhập dữ liệu thành công.");
    }catch(e){ toast("File không hợp lệ."); }
  };
  reader.readAsText(file);
}

/* ============ NAV / VIEW SWITCH ============ */
function showView(name){
  state.view = name;
  $$(".view").forEach(v=>v.classList.remove("active"));
  $("#view-"+name).classList.add("active");
  $$(".navbtn").forEach(b=>b.classList.toggle("active", b.dataset.view===name));
  if(name==="me") renderMe();
  if(name==="practice"){
    const activeSub = $("#practiceSubRow .chip.on")?.dataset.sub || "flashcard";
    showPracticeSub(activeSub);
  }
  if(name==="tools") renderToolsHome();
}
function showPracticeSub(sub){
  $$("#practiceSubRow .chip").forEach(c=>c.classList.toggle("on", c.dataset.sub===sub));
  $$(".practice-pane").forEach(p=>p.classList.add("hidden"));
  $("#practice-"+sub).classList.remove("hidden");
  if(sub==="reading" && !$("#readingArea").innerHTML){ renderReadingList(); renderReadingArea(); }
}

/* ============ INIT ============ */
function init(){
  loadFromStorage();
  applySettings();
  renderVocabTopics();
  renderVocabList();
  renderKanjiList();
  renderGrammar();
  renderReadingList();
  renderReadingArea();
  setupMyWords();
  renderMyWordsList();
  setupMyGrammar();
  renderMyGrammarList();
  setupTools();

  $$(".navbtn").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
  $$("#practiceSubRow .chip").forEach(c=>c.addEventListener("click",()=>showPracticeSub(c.dataset.sub)));

  // Dictionary
  $("#dictSearchBtn").addEventListener("click", doDictSearch);
  $("#dictInput").addEventListener("keydown",e=>{ if(e.key==="Enter") doDictSearch(); });
  $$("#dictDirRow .chip").forEach(c=>c.addEventListener("click",()=>{
    state.dictDir = c.dataset.dir;
    $$("#dictDirRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
  }));
  setupMic($("#dictMic"), (text)=>{ $("#dictInput").value = text; doDictSearch(); });

  // Kanji
  $("#kanjiSearchBtn").addEventListener("click", renderKanjiList);
  $("#kanjiInput").addEventListener("keydown",e=>{ if(e.key==="Enter") renderKanjiList(); });
  $$("#kanjiLevelRow .chip").forEach(c=>c.addEventListener("click",()=>{
    kanjiLevelFilter = c.dataset.lvl;
    $$("#kanjiLevelRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
    renderKanjiList();
  }));
  setupHandwriting();

  // Grammar
  $("#grammarSearchBtn").addEventListener("click", renderGrammar);
  $("#grammarInput").addEventListener("keydown",e=>{ if(e.key==="Enter") renderGrammar(); });
  $$("#grammarLevelRow .chip").forEach(c=>c.addEventListener("click",()=>{
    grammarLevelFilter = c.dataset.lvl;
    $$("#grammarLevelRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
    renderGrammar();
  }));

  // Translate
  $$("[data-tdir]").forEach(c=>c.addEventListener("click",()=>{
    tdir = c.dataset.tdir; $$("[data-tdir]").forEach(x=>x.classList.remove("on")); c.classList.add("on");
  }));
  $("#translateBtn").addEventListener("click",()=>{
    const text = $("#translateInput").value.trim();
    if(!text) return;
    const parts = tdir==="jv"? translateJPtoVI(text) : translateVItoJP(text);
    $("#translateOutputCard").style.display = "block";
    const foundCount = parts.filter(p=>p.found).length;
    if(!parts.length || foundCount===0){
      $("#translateOutput").innerHTML = `<span class="muted">Chưa nhận diện được từ nào trong câu này — kể cả sau khi thử giải chia động từ/tính từ. Từ này có thể chưa có trong từ điển offline. Hãy thử tra riêng ở tab "Từ điển", hoặc tự thêm ở tab "Thêm nội dung".</span>`;
      $("#translateGlossary").innerHTML = "";
      $("#translateGrammarHints").innerHTML = "";
      return;
    }
    $("#translateOutput").innerHTML = parts.map((p,idx)=>{
      if(p.found){
        const label = p.entry.vi && p.entry.vi.length? p.entry.vi[0] : (p.entry.meaning || "(chưa có nghĩa)");
        return `<span class="tr-word" data-idx="${idx}" style="color:var(--indigo-deep);font-weight:600;cursor:pointer;border-bottom:1px dashed var(--indigo);" title="Bấm để xem chi tiết">${escapeHtml(p.text)}<sub style="font-size:.7em;color:var(--ink-soft);">(${escapeHtml(label)})</sub></span>`;
      }
      return `<span class="muted" style="text-decoration:underline dotted;" title="Chưa có trong từ điển">${escapeHtml(p.text)}</span>`;
    }).join("");

    // Từ vựng dùng trong câu (glossary) — loại trùng
    const seen = new Set();
    const glossaryItems = parts.filter(p=>p.found && p.entry).filter(p=>{
      const k = vkey(p.entry); if(seen.has(k)) return false; seen.add(k); return true;
    });
    $("#translateGlossary").innerHTML = glossaryItems.length? `
      <div class="section-title"><span>📚 Từ vựng trong câu (bấm để xem chi tiết)</span></div>
      ${glossaryItems.map(p=>wordCardHTML(p.entry)).join("")}
    ` : "";
    bindWordCardActions($("#translateGlossary"));

    // Ngữ pháp liên quan trong câu
    const grammarHits = findGrammarInSentence(text);
    $("#translateGrammarHints").innerHTML = grammarHits.length? `
      <div class="section-title"><span>📝 Ngữ pháp xuất hiện trong câu</span></div>
      ${grammarHits.map(g=>`<div class="card">
        <div class="word-title"><span class="jp" style="font-size:1.15rem;">${g.pattern}</span><span class="pill level lvl-${levelSlug(g.level)}">${g.level}</span></div>
        <div style="margin-top:.3rem;"><b>Ý nghĩa:</b> ${g.meaning}</div>
        ${g.structure? `<div><b>Cấu trúc:</b> ${g.structure}</div>`:""}
        ${g.usage? `<div><b>Cách dùng:</b> ${g.usage}</div>`:""}
      </div>`).join("")}
    ` : `<p class="muted" style="font-size:.82rem;">Không phát hiện mẫu ngữ pháp cụ thể nào khớp trong câu này (bộ nhận diện dựa trên so khớp mẫu, có thể bỏ sót).</p>`;

    // click từng từ trong câu để nhảy xuống glossary tương ứng / mở nhanh chi tiết
    $$(".tr-word", $("#translateOutput")).forEach(span=>{
      span.addEventListener("click",()=>{
        const idx = +span.dataset.idx;
        const entry = parts[idx].entry;
        if(!entry) return;
        speak(entry.kanji||entry.hira, "ja-JP");
        const card = $(`#translateGlossary [data-key="${CSS.escape(vkey(entry))}"]`);
        if(card) card.scrollIntoView({behavior:"smooth", block:"center"});
      });
    });
  });
  $("#translateSpeak").addEventListener("click",()=>{
    const text = $("#translateInput").value.trim();
    if(text) speak(text, tdir==="jv"?"ja-JP":"vi-VN");
  });
  $("#ocrInput").addEventListener("change",()=>{
    $("#ocrNote").textContent = "Bản offline hiện chưa tích hợp OCR nhận diện chữ trong ảnh (cần mô hình AI/API riêng). Bạn có thể gõ tay đoạn văn cần dịch vào ô bên trên.";
  });

  // Vocab
  $$("#vocabLevelRow .chip").forEach(c=>c.addEventListener("click",()=>{
    vocabLevelFilter = c.dataset.lvl;
    $$("#vocabLevelRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
    renderVocabList();
  }));

  // Flashcard
  $$("[data-deck]").forEach(b=>b.addEventListener("click",()=>renderFlashcardArea(b.dataset.deck)));

  // JLPT
  $$("#jlptLevelRow .chip").forEach(c=>c.addEventListener("click",()=>{
    $$("#jlptLevelRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
  }));
  $$("#jlptTypeRow .chip").forEach(c=>c.addEventListener("click",()=>{
    $$("#jlptTypeRow .chip").forEach(x=>x.classList.remove("on")); c.classList.add("on");
  }));
  $("#jlptStart").addEventListener("click", startJLPT);

  // Me tabs
  $$("[data-metab]").forEach(c=>c.addEventListener("click",()=>{
    meTab = c.dataset.metab; $$("[data-metab]").forEach(x=>x.classList.remove("on")); c.classList.add("on"); renderMe();
  }));

  // Settings
  $("#themeToggle").addEventListener("click",()=>{
    state.settings.theme = state.settings.theme==="dark"? "light":"dark"; applySettings();
  });
  $("#langToggle").addEventListener("click",()=>{
    state.settings.lang = state.settings.lang==="vi"? "en":"vi"; applySettings();
    toast(state.settings.lang==="en"? "English UI is a work in progress — most labels remain in Vietnamese for now." : "Đã chuyển sang tiếng Việt.");
  });
  $("#setDark").addEventListener("change",e=>{ state.settings.theme = e.target.checked? "dark":"light"; applySettings(); });
  $("#setBigFont").addEventListener("change",e=>{ state.settings.bigfont = e.target.checked; applySettings(); });
  $("#setLang").addEventListener("change",e=>{ state.settings.lang = e.target.value; applySettings(); });
  $("#exportData").addEventListener("click", exportData);
  $("#importData").addEventListener("change",e=>{ if(e.target.files[0]) importData(e.target.files[0]); });
  $("#clearData").addEventListener("click",()=>{
    if(confirm("Xóa toàn bộ lịch sử, yêu thích, danh sách học và ghi chú?")){
      state.favorites={}; state.mylist={}; state.notes={}; state.fc={}; state.history=[];
      saveToStorage();
      renderMe(); toast("Đã xóa dữ liệu cá nhân.");
    }
  });

  // Save once more when the user leaves/closes the tab, just in case
  window.addEventListener("beforeunload", saveToStorage);
}

document.addEventListener("DOMContentLoaded", init);
})();
