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
    const payload = {favorites:state.favorites, mylist:state.mylist, notes:state.notes, fc:state.fc, history:state.history, settings:state.settings, customVocab:state.customVocab, customGrammar:state.customGrammar};
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
    state.settings = Object.assign(state.settings, data.settings||{});
  }catch(e){ /* corrupted data - start fresh */ }
}

function vkey(v){ return (v.kanji||"")+"|"+(v.hira||""); }
function kkey(k){ return k.char; }
function levelSlug(lvl){ return (lvl||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,""); }
function allVocab(){ return [...VOCAB_CLEAN, ...state.customVocab]; }
function allGrammar(){ return [...GRAMMAR, ...state.customGrammar]; }

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
  return `
  <div class="card" data-key="${escapeAttr(key)}">
    <div class="word-title">
      <span class="jp">${v.kanji}</span>
      <span class="kana">${v.hira}${v.kata? " / "+v.kata:""}</span>
      <span class="romaji">${v.romaji}</span>
      <span class="pill level lvl-${levelSlug(v.level)}">${v.level}</span>
      <span class="pill">${v.pos}</span>
    </div>
    <div class="muted" style="font-size:.8rem;margin-top:.2rem;">${v.topic||""}</div>
    <div style="margin-top:.5rem;"><b>Nghĩa (VI):</b> ${v.vi.join("; ")}</div>
    ${v.en.length? `<div><b>Nghĩa (EN):</b> ${v.en.join("; ")}</div>`:""}
    ${v.jp? `<div class="muted" style="margin-top:.3rem;"><b>日本語:</b> ${v.jp}</div>`:""}
    ${v.examples.map(ex=>`<div class="example"><div class="jp">${ex.jp}</div><div class="muted">${ex.romaji}</div><div>${ex.vi}</div></div>`).join("")}
    ${v.synonyms && v.synonyms.length? `<div style="margin-top:.3rem;"><b>Đồng nghĩa/liên quan:</b> ${v.synonyms.join(", ")}</div>`:""}
    ${v.compounds && v.compounds.length? `<div><b>Từ ghép:</b> ${v.compounds.join(", ")}</div>`:""}
    <div class="row-actions">
      <button class="act-speak">🔊 Phát âm</button>
      <button class="act-img">🖼 Hình ảnh liên quan</button>
      <button class="act-fav ${isFav?'active':''}">${isFav? '★ Đã lưu':'☆ Yêu thích'}</button>
      <button class="act-list ${isList?'active':''}">${isList? '✓ Trong danh sách':'+ Thêm vào danh sách học'}</button>
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
  box.innerHTML = list.map(wordCardHTML).join("");
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
    <div class="m">${k.meaning}</div>
    <div class="pill level lvl-${k.level}" style="margin-top:.3rem;">${k.level}</div>
  </div>`;
}
function kanjiDetailHTML(k){
  return `<div class="card">
    <div class="word-title"><span class="jp" style="font-size:2.2rem;">${k.char}</span>
      <span class="pill level lvl-${k.level}">${k.level}</span><span class="pill">${k.strokes} nét</span><span class="pill">Bộ: ${k.radical}</span></div>
    <div style="margin-top:.4rem;"><b>Nghĩa:</b> ${k.meaning}</div>
    <div><b>Âm On'yomi:</b> ${k.onyomi.join("、")||"—"}</div>
    <div><b>Âm Kun'yomi:</b> ${k.kunyomi.join("、")||"—"}</div>
    ${k.compounds.length? `<div style="margin-top:.4rem;"><b>Từ ghép:</b>${k.compounds.map(c=>`<div class="example"><span class="jp">${c.word}</span> (${c.reading}) — ${c.meaning}</div>`).join("")}</div>`:""}
    <div class="row-actions"><button onclick="window.speakJP('${k.char}')">🔊 Phát âm</button></div>
  </div>`;
}
window.speakJP = (t)=>speak(t,"ja-JP");

let kanjiLevelFilter = "all";
function renderKanjiList(){
  const q = normalize($("#kanjiInput").value);
  let list = KANJI_CLEAN.filter(k=>{
    if(kanjiLevelFilter!=="all" && k.level!==kanjiLevelFilter) return false;
    if(!q) return true;
    return k.char.includes(q) || k.meaning.toLowerCase().includes(q) ||
      k.onyomi.join(" ").toLowerCase().includes(q) || k.kunyomi.join(" ").toLowerCase().includes(q);
  });
  const box = $("#kanjiResults");
  if(!list.length){ box.innerHTML = `<div class="empty"><span class="big-ico">漢</span>Không tìm thấy Kanji phù hợp.</div>`; return; }
  box.innerHTML = list.map(kanjiCardHTML).join("");
  $$(".kanji-tile", box).forEach(tile=>{
    tile.addEventListener("click",()=>{
      const k = KANJI_CLEAN.find(k=>k.char===tile.dataset.char);
      box.insertAdjacentHTML("beforebegin", kanjiDetailHTML(k));
      logHistory("kanji", k.char);
      $("main").scrollIntoView({behavior:"smooth"});
    });
  });
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
    const candidates = KANJI_CLEAN.filter(k=>Math.abs(k.strokes-strokeCount)<=1).sort((a,b)=>Math.abs(a.strokes-strokeCount)-Math.abs(b.strokes-strokeCount)).slice(0,8);
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

/* ============ TRANSLATE (demo, dictionary-based gloss) ============ */
let tdir = "jv";
function translateJPtoVI(text){
  // greedy longest-match against VOCAB kanji/hira
  const dict = [...allVocab()].sort((a,b)=>(b.kanji.length)-(a.kanji.length));
  let parts = []; let i = 0;
  const chars = Array.from(text);
  while(i < chars.length){
    let matched = null;
    for(const v of dict){
      const forms = [v.kanji, v.hira].filter(Boolean);
      for(const f of forms){
        if(f && text.startsWith(f, i)){ if(!matched || f.length>matched.form.length) matched = {form:f, v}; }
      }
    }
    if(matched){ parts.push({text:matched.form, vi:matched.v.vi[0], found:true}); i += matched.form.length; }
    else {
      // gom các ký tự chưa nhận diện được (trợ từ, chữ chưa có trong từ điển) thành 1 cụm
      let start = i; i++;
      while(i < chars.length){
        let peekMatched = false;
        for(const v of dict){
          const forms = [v.kanji, v.hira].filter(Boolean);
          if(forms.some(f=>f && text.startsWith(f, i))){ peekMatched = true; break; }
        }
        if(peekMatched) break;
        i++;
      }
      const chunk = text.slice(start, i);
      if(chunk.trim()) parts.push({text:chunk, vi:null, found:false});
    }
  }
  return parts;
}
function translateVItoJP(text){
  const words = text.toLowerCase().split(/[\s,.!?;]+/).filter(Boolean);
  let parts = [];
  words.forEach(w=>{
    const hit = allVocab().find(v=>v.vi.some(m=>m.toLowerCase()===w) || v.vi.some(m=>m.toLowerCase().includes(w)));
    parts.push({text:w, vi: hit? (hit.kanji||hit.hira): null, found: !!hit});
  });
  return parts;
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
function renderVocabList(){
  let list = allVocab().filter(v=>{
    if(vocabLevelFilter!=="all" && v.level!==vocabLevelFilter) return false;
    if(vocabTopicFilter!=="all" && v.topic!==vocabTopicFilter) return false;
    return true;
  });
  const box = $("#vocabResults");
  box.innerHTML = list.length? list.map(wordCardHTML).join("") : `<div class="empty"><span class="big-ico">🗂</span>Không có từ nào trong bộ lọc này.</div>`;
  bindWordCardActions(box);
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
    pool = KANJI_CLEAN.filter(k=>k.level===level);
    if(pool.length<4) pool = KANJI_CLEAN;
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
  const payload = {favorites:state.favorites, mylist:state.mylist, notes:state.notes, fc:state.fc, history:state.history, settings:state.settings, customVocab:state.customVocab, customGrammar:state.customGrammar};
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
  $$("#tabs button").forEach(b=>b.classList.toggle("active", b.dataset.view===name));
  if(name==="me") renderMe();
  if(name==="reading" && !$("#readingArea").innerHTML) { renderReadingList(); renderReadingArea(); }
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

  $$("#tabs button").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));

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
      $("#translateOutput").innerHTML = `<span class="muted">Chưa nhận diện được từ nào trong câu này — bộ từ điển offline hiện còn nhỏ (khoảng 150 từ), nên nhiều từ (đặc biệt từ chuyên ngành/ít gặp) sẽ chưa có. Hãy thử tra từng từ riêng lẻ ở tab "Từ điển".</span>`;
    } else {
      $("#translateOutput").innerHTML = parts.map(p=>{
        if(p.found) return `<span style="color:var(--indigo-deep);font-weight:600;" title="${escapeAttr(p.text)}">${escapeHtml(p.vi)}</span>`;
        return `<span class="muted" style="text-decoration:underline dotted;" title="Chưa có trong từ điển">[${escapeHtml(p.text)}]</span>`;
      }).join(" ");
    }
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
