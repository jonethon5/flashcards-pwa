import * as db from "./db.js";
import * as S from "./scheduler.js";
import {
  renderCard,
  cardOrdsFor,
  builtinNotetypes,
  clozeNumbers,
  escapeHtml as h,
  stripHtml,
  BUILTIN_IDS,
} from "./render.js";
import { parseApkg } from "./importer.js";
import { loadApkgLibs } from "./libs.js";
import { buildBackup, readBackup, applyBackup, deliverFile } from "./backup.js";

const $ = (sel, el = document) => el.querySelector(sel);
const main = $("#main");
const foot = $("#foot");
const titleEl = $("#title");
const backBtn = $("#back");
const barActions = $("#bar-actions");
const nav = $("#nav");

const state = {
  decks: [],
  notetypes: new Map(),
  cards: new Map(),
  todayLog: [],
  config: { ...S.DEFAULT_CONFIG, autoplay: true },
  view: "home",
  onBack: null,
};

let study = null;
let editor = null;
let browse = null;

// ---------- Utilidades de interface ----------

function toast(message, ms = 2600) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function busy(text) {
  $("#overlay-text").textContent = text;
  $("#overlay").hidden = false;
}

function idle() {
  $("#overlay").hidden = true;
}

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

function chrome({ title, back = null, actions = "", showNav = true, flush = false }) {
  titleEl.textContent = title;
  state.onBack = back;
  backBtn.hidden = !back;
  barActions.innerHTML = actions;
  nav.hidden = !showNav;
  main.classList.toggle("flush", flush);
  foot.innerHTML = "";
  main.scrollTop = 0;
  for (const btn of nav.querySelectorAll("button")) {
    btn.classList.toggle("on", btn.dataset.view === state.view);
  }
}

function countsHtml(c) {
  const part = (cls, n) => `<span class="${cls}${n ? "" : " zero"}">${n}</span>`;
  return `<span class="counts">${part("c-new", c.new)}${part("c-learn", c.learn)}${part("c-review", c.review)}</span>`;
}

// ---------- Dados ----------

async function loadState() {
  const [decks, notetypes, cards, config] = await Promise.all([
    db.getAll("decks"),
    db.getAll("notetypes"),
    db.getAll("cards"),
    db.getMeta("config", {}),
  ]);
  state.decks = decks.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
  state.notetypes = new Map(notetypes.map((t) => [t.id, t]));
  state.cards = new Map(cards.map((c) => [c.id, c]));
  state.config = { ...S.DEFAULT_CONFIG, autoplay: true, ...config };
  for (const nt of builtinNotetypes()) {
    if (!state.notetypes.has(nt.id)) {
      state.notetypes.set(nt.id, nt);
      await db.put("notetypes", nt);
    }
  }
  state.todayLog = await db.getByIndex("revlog", "ts", IDBKeyRange.lowerBound(S.dayStart()));
}

function sortDecks() {
  state.decks.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
}

const deckById = (id) => state.decks.find((d) => d.id === id);

// Um baralho inclui os seus sub-baralhos ("Pai::Filho").
function familyIds(deck) {
  const prefix = `${deck.name}::`;
  return new Set(state.decks.filter((d) => d.id === deck.id || d.name.startsWith(prefix)).map((d) => d.id));
}

function doneToday(ids) {
  const today = S.dayStart();
  const done = { new: 0, review: 0 };
  for (const entry of state.todayLog) {
    if (entry.ts >= today && ids.has(entry.deckId) && entry.kind in done) done[entry.kind]++;
  }
  return done;
}

function familyCards(ids) {
  const out = [];
  for (const c of state.cards.values()) if (ids.has(c.deckId)) out.push(c);
  return out;
}

function deckCounts(deck) {
  const ids = familyIds(deck);
  const q = S.buildQueues(familyCards(ids), Date.now(), state.config, doneToday(ids));
  return { new: q.new.length, learn: q.learn.length, review: q.review.length };
}

async function saveConfig() {
  const { newPerDay, revPerDay, autoplay } = state.config;
  await db.setMeta("config", { newPerDay, revPerDay, autoplay });
}

// ---------- Mídia ----------

const urlCache = new Map();

async function mediaUrl(name) {
  const candidates = new Set([name, name.normalize("NFC")]);
  try {
    const decoded = decodeURIComponent(name);
    candidates.add(decoded).add(decoded.normalize("NFC"));
  } catch {
    // nome com "%" literal: fica só com as formas originais
  }
  for (const key of candidates) {
    if (urlCache.has(key)) return urlCache.get(key);
    const row = await db.get("media", key);
    if (row) {
      const url = URL.createObjectURL(new Blob([row.data], { type: row.type }));
      urlCache.set(key, url);
      return url;
    }
  }
  return null;
}

function clearMediaCache() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// Conteúdo de baralhos compartilhados é HTML de terceiros: remove tudo o que executa código.
function sanitize(html, { keepStyle = true } = {}) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const blocked = `script,iframe,object,embed,link,meta,base,form${keepStyle ? "" : ",style"}`;
  for (const el of tpl.content.querySelectorAll(blocked)) el.remove();
  for (const el of tpl.content.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith("on") || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  return tpl.content;
}

async function resolveImages(root) {
  for (const img of root.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (/^(https?:|data:|blob:)/i.test(src)) continue;
    img.dataset.fname = src;
    img.removeAttribute("src");
    const url = await mediaUrl(src);
    if (url) img.src = url;
  }
}

// Um décimo de segundo de silêncio em WAV. Precisa ter amostras de verdade: o iPhone recusa tocar um arquivo vazio.
function silentWav() {
  const samples = 2205;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (pos, value) => [...value].forEach((ch, k) => view.setUint8(pos + k, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 22050, true);
  view.setUint32(28, 44100, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([view.buffer], { type: "audio/wav" }));
}

const SILENCE = silentWav();
const player = new Audio();
let playToken = 0;
let releasePlayback = null;
let audioUnlocked = false;

// O iOS só libera áudio depois de um toque, e só no elemento que tocou dentro desse toque.
// No primeiro toque em qualquer lugar, o player toca o silêncio; depois disso pode tocar os cartões.
function unlockAudio() {
  if (audioUnlocked || !player.paused) return;
  player.src = SILENCE;
  player
    .play()
    .then(() => (audioUnlocked = true))
    .catch(() => {});
}

for (const type of ["touchend", "click", "keydown"]) document.addEventListener(type, unlockAudio, { capture: true, passive: true });
function stopAudio() {
  playToken++;
  player.pause();
  releasePlayback?.();
}

async function playSounds(names) {
  stopAudio();
  const token = playToken;
  for (const name of names) {
    const url = await mediaUrl(name);
    if (token !== playToken) return;
    if (!url) continue;
    player.src = url;
    try {
      await player.play();
    } catch {
      return;
    }
    await new Promise((resolve) => {
      releasePlayback = resolve;
      player.onended = resolve;
      player.onerror = resolve;
    });
    if (token !== playToken) return;
  }
}

// ---------- Início: lista de baralhos ----------

function installHint() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (!ios || standalone || localStorage.getItem("hideInstallHint")) return "";
  return `<div class="banner"><div class="grow">Para instalar no iPhone, toque em <b>Compartilhar</b> no Safari e depois em <b>Adicionar à Tela de Início</b>.</div><button data-act="hide-hint" aria-label="Fechar">×</button></div>`;
}

function showHome() {
  state.view = "home";
  stopAudio();
  clearMediaCache();
  chrome({
    title: "Baralhos",
    actions: `<button class="bar-btn" data-act="new-deck">Novo</button>`,
  });
  if (!state.decks.length) {
    main.innerHTML = `${installHint()}
      <div class="empty"><h2>Nenhum baralho ainda</h2><p>Importe um baralho exportado do Anki ou crie um novo aqui.</p></div>
      <button class="btn" data-act="import">Importar do Anki (.apkg)</button>
      <button class="btn plain" data-act="new-deck">Criar baralho</button>`;
    return;
  }
  const rows = state.decks
    .map((deck) => {
      const parts = deck.name.split("::");
      const depth = parts.length - 1;
      return `<button class="row" data-act="open-deck" data-id="${deck.id}">
        <span class="grow" style="padding-left:${depth * 16}px">${h(parts[depth])}</span>${countsHtml(deckCounts(deck))}</button>`;
    })
    .join("");
  main.innerHTML = `${installHint()}<div class="group">${rows}</div>`;
}

async function createDeck() {
  const name = (prompt("Nome do novo baralho:") || "").trim();
  if (!name) return null;
  const existing = state.decks.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    toast("Já existe um baralho com esse nome.");
    return existing;
  }
  const deck = { id: db.newId(), name };
  await db.put("decks", deck);
  state.decks.push(deck);
  sortDecks();
  return deck;
}

// ---------- Tela do baralho ----------

function showDeck(deckId) {
  const deck = deckById(deckId);
  if (!deck) return showHome();
  state.view = "home";
  const counts = deckCounts(deck);
  const total = familyCards(familyIds(deck)).length;
  const due = counts.new + counts.learn + counts.review;
  chrome({ title: deck.name.split("::").pop(), back: showHome });
  main.innerHTML = `
    <div class="summary">
      <div><b class="c-new">${counts.new}</b><span>Novos</span></div>
      <div><b class="c-learn">${counts.learn}</b><span>Aprendendo</span></div>
      <div><b class="c-review">${counts.review}</b><span>A revisar</span></div>
    </div>
    <button class="btn" data-act="study" data-id="${deck.id}" ${due ? "" : "disabled"}>${due ? "Estudar agora" : total ? "Concluído por hoje" : "Baralho vazio"}</button>
    <div class="group" style="margin-top:10px">
      <button class="row accent" data-act="add-to" data-id="${deck.id}">Adicionar cartão</button>
      <button class="row accent" data-act="browse" data-id="${deck.id}"><span class="grow">Ver cartões</span><span class="sub">${total}</span></button>
      <button class="row accent" data-act="rename-deck" data-id="${deck.id}">Renomear</button>
      <button class="row danger" data-act="delete-deck" data-id="${deck.id}">Excluir baralho</button>
    </div>`;
}

async function renameDeck(deckId) {
  const deck = deckById(deckId);
  const name = (prompt("Novo nome do baralho:", deck.name) || "").trim();
  if (!name || name === deck.name) return;
  const prefix = `${deck.name}::`;
  const changed = [];
  for (const d of state.decks) {
    if (d.id === deck.id) continue;
    if (d.name.startsWith(prefix)) {
      d.name = `${name}::${d.name.slice(prefix.length)}`;
      changed.push(d);
    }
  }
  deck.name = name;
  changed.push(deck);
  await db.bulkPut("decks", changed);
  sortDecks();
  showDeck(deckId);
}

async function deleteNotesWithoutCards(noteIds) {
  const alive = new Set();
  for (const c of state.cards.values()) alive.add(c.noteId);
  await db.bulkDel("notes", [...noteIds].filter((id) => !alive.has(id)));
}

async function deleteDeck(deckId) {
  const deck = deckById(deckId);
  const ids = familyIds(deck);
  const cards = familyCards(ids);
  const extra = ids.size > 1 ? ` e os ${ids.size - 1} sub-baralhos` : "";
  if (!confirm(`Excluir "${deck.name}"${extra}, com ${cards.length} cartões? Isso não pode ser desfeito.`)) return;
  for (const c of cards) state.cards.delete(c.id);
  await db.bulkDel("cards", cards.map((c) => c.id));
  await deleteNotesWithoutCards(new Set(cards.map((c) => c.noteId)));
  await db.bulkDel("decks", [...ids]);
  state.decks = state.decks.filter((d) => !ids.has(d.id));
  showHome();
}

// ---------- Estudo ----------

const BASE_CARD_CSS = `:host{display:block}
.card{margin:0;padding:20px 16px 28px;min-height:100%;font-family:arial,sans-serif;font-size:20px;text-align:center;color:black;background-color:white;overflow-wrap:anywhere}
.card.nightMode{color:#f2f2f7;background-color:#1c1c1e}
.nightMode [style*="background"]{color:#000}
img{max-width:100%;height:auto}
hr{border:0;border-top:1px solid #9998;margin:18px 0}
.cloze{font-weight:bold;color:#0a58ca}
.nightMode .cloze{color:#7ab8ff}
.missing{color:#d23b30;font-size:14px}
.hint summary{cursor:pointer;color:#0a66d8}
.snd{font:inherit;font-size:18px;width:48px;height:48px;border-radius:50%;border:1px solid #9996;background:transparent;color:inherit;margin:6px;cursor:pointer}
`;

function startStudy(deckId) {
  const deck = deckById(deckId);
  if (!deck) return showHome();
  unlockAudio();
  study = { deckId, ids: familyIds(deck), current: null, shown: false, undo: null, sinceNew: 0 };
  state.view = "study";
  chrome({
    title: deck.name.split("::").pop(),
    back: () => showDeck(deckId),
    actions: `<button class="bar-btn" data-act="undo" id="undo" disabled>Desfazer</button><button class="bar-btn" data-act="edit-current">Editar</button>`,
    showNav: false,
    flush: true,
  });
  main.innerHTML = `<div class="study-counts" id="study-counts"></div><div id="card-area"></div>`;
  advance();
}

function currentQueues() {
  const now = Date.now();
  const queues = S.buildQueues(familyCards(study.ids), now, state.config, doneToday(study.ids));
  queues.sinceNew = study.sinceNew;
  return { queues, now };
}

function advance() {
  const { queues, now } = currentQueues();
  study.current = S.nextCard(queues, now);
  study.sinceNew = queues.sinceNew;
  study.shown = false;
  study.queues = queues;
  drawStudy();
}

function studyCountsHtml() {
  const q = study.queues;
  const cur = study.current;
  const kind = !cur ? "" : cur.state === "new" ? "new" : cur.state === "review" ? "review" : "learn";
  const part = (cls, key, n) => `<span class="${cls}${kind === key ? " cur" : ""}">${n}</span>`;
  return part("c-new", "new", q.new.length) + part("c-learn", "learn", q.learn.length) + part("c-review", "review", q.review.length);
}

async function drawStudy() {
  $("#undo").disabled = !study.undo;
  $("#study-counts").innerHTML = studyCountsHtml();
  const area = $("#card-area");
  const card = study.current;
  if (!card) {
    stopAudio();
    const waiting = study.queues.learn.length;
    const wait = waiting ? Math.max(1, Math.ceil((study.queues.learn[0].due - Date.now()) / S.MIN)) : 0;
    area.innerHTML = `<div class="empty"><h2>Concluído por hoje</h2><p>${
      waiting
        ? `${waiting} ${waiting === 1 ? "cartão em aprendizado volta" : "cartões em aprendizado voltam"} em cerca de ${wait} min.`
        : "Você terminou os cartões deste baralho."
    }</p></div>`;
    foot.innerHTML = `<button class="btn" data-act="back">Voltar</button>`;
    return;
  }

  const token = (study.drawToken = (study.drawToken || 0) + 1);
  const note = await db.get("notes", card.noteId);
  const notetype = note && state.notetypes.get(note.ntid);
  if (study?.drawToken !== token) return;
  if (!note || !notetype) {
    area.innerHTML = `<div class="empty"><p>Este cartão está sem nota ou tipo de nota.</p></div>`;
    foot.innerHTML = `<button class="btn" data-act="skip-broken">Excluir cartão e continuar</button>`;
    return;
  }

  const out = renderCard(card, note, notetype, deckById(card.deckId)?.name || "");
  const frag = sanitize(study.shown ? out.a : out.q);
  await resolveImages(frag);
  if (study?.drawToken !== token) return;

  const host = document.createElement("div");
  host.style.minHeight = "100%";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = BASE_CARD_CSS + out.css;
  const wrap = document.createElement("div");
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  wrap.className = `card card${card.ord + 1}${dark ? " nightMode night_mode" : ""}`;
  wrap.append(frag);
  shadow.append(style, wrap);
  wrap.addEventListener("click", (event) => {
    const btn = event.target.closest(".snd");
    if (btn) playSounds([btn.dataset.snd]);
  });
  area.replaceChildren(host);
  const answerMark = study.shown && wrap.querySelector("#answer");
  if (answerMark) answerMark.scrollIntoView({ block: "start" });
  else area.scrollTop = 0;

  if (!study.shown) {
    foot.innerHTML = `<button class="btn" data-act="show-answer">Mostrar resposta</button>`;
  } else {
    const now = Date.now();
    const label = (r) => S.intervalLabel(card, r, now, state.config);
    foot.innerHTML = `<div class="answers">
      <button class="a-again" data-act="rate" data-r="1">Errei<small>${label(1)}</small></button>
      <button data-act="rate" data-r="2">Difícil<small>${label(2)}</small></button>
      <button class="a-good" data-act="rate" data-r="3">Bom<small>${label(3)}</small></button>
      <button class="a-easy" data-act="rate" data-r="4">Fácil<small>${label(4)}</small></button>
    </div>`;
  }

  const sounds = [...wrap.querySelectorAll(".snd:not([data-quiet])")].map((b) => b.dataset.snd);
  if (state.config.autoplay && sounds.length) playSounds(sounds);
  else stopAudio();
}

async function rate(rating) {
  const card = study.current;
  if (!card || !study.shown || study.saving) return;
  study.saving = true;
  try {
    const now = Date.now();
    const kind = card.state === "new" ? "new" : card.state === "review" ? "review" : "learn";
    const next = S.answer(card, rating, now, state.config, Math.random);
    const entry = { cardId: card.id, deckId: card.deckId, ts: now, rating, kind };
    await db.put("cards", next);
    entry.id = await db.add("revlog", entry);
    state.cards.set(card.id, next);
    state.todayLog.push(entry);
    study.undo = { prev: card, logId: entry.id };
  } finally {
    study.saving = false;
  }
  advance();
}

async function undoAnswer() {
  if (!study?.undo) return;
  const { prev, logId } = study.undo;
  study.undo = null;
  await db.put("cards", prev);
  await db.del("revlog", logId);
  state.cards.set(prev.id, prev);
  state.todayLog = state.todayLog.filter((e) => e.id !== logId);
  const { queues } = currentQueues();
  study.queues = queues;
  study.current = prev;
  study.shown = false;
  drawStudy();
}

async function skipBroken() {
  const card = study.current;
  state.cards.delete(card.id);
  await db.del("cards", card.id);
  advance();
}

// ---------- Editor de notas ----------

let savedRange = null;

document.addEventListener("selectionchange", () => {
  const sel = document.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (el?.closest(".field")) savedRange = range.cloneRange();
});

function usableTypes() {
  // Tipos do próprio app primeiro (ids pequenos), depois os importados por nome.
  const builtin = (t) => (t.id <= BUILTIN_IDS.cloze ? 0 : 1);
  return [...state.notetypes.values()]
    .filter((t) => t.templates.length && t.fields.length)
    .sort((a, b) => builtin(a) - builtin(b) || (builtin(a) ? a.name.localeCompare(b.name) : a.id - b.id));
}

async function showEditor({ noteId = null, deckId = null, back }) {
  let note = null;
  let noteCards = [];
  if (noteId) {
    note = await db.get("notes", noteId);
    noteCards = [...state.cards.values()].filter((c) => c.noteId === noteId);
    if (!note) return back();
    deckId = noteCards[0]?.deckId ?? deckId;
  }
  if (!state.decks.length) {
    const deck = await createDeck();
    if (!deck) return showHome();
  }
  const lastDeck = Number(localStorage.getItem("lastDeck"));
  const lastType = Number(localStorage.getItem("lastType"));
  editor = {
    noteId,
    back,
    deckId: deckById(deckId) ? deckId : deckById(lastDeck) ? lastDeck : state.decks[0].id,
    ntid: note ? note.ntid : state.notetypes.has(lastType) ? lastType : BUILTIN_IDS.basic,
    values: note ? note.fields : null,
    tags: note ? note.tags : "",
  };
  state.view = noteId ? "edit" : "add";
  await drawEditor();
}

async function drawEditor() {
  const nt = state.notetypes.get(editor.ntid);
  const editing = editor.noteId !== null;
  chrome({
    title: editing ? "Editar cartão" : "Adicionar cartão",
    back: editor.back,
    actions: `<button class="bar-btn" data-act="save-note"><b>${editing ? "Salvar" : "Adicionar"}</b></button>`,
    showNav: !editing && !editor.back,
  });
  const deckOptions = state.decks
    .map((d) => `<option value="${d.id}" ${d.id === editor.deckId ? "selected" : ""}>${h(d.name)}</option>`)
    .join("");
  const typeOptions = usableTypes()
    .map((t) => `<option value="${t.id}" ${t.id === editor.ntid ? "selected" : ""}>${h(t.name)}</option>`)
    .join("");
  const cloze = nt.kind === 1;
  const fields = nt.fields
    .map(
      (name, i) => `<div class="field-label"><span>${h(name)}</span><span class="field-tools">${
        cloze ? `<button data-act="cloze" data-i="${i}">[...] Omitir</button>` : ""
      }<button data-act="pick-image" data-i="${i}">Imagem</button></span></div>
      <div class="field" contenteditable="true" data-i="${i}"></div>`,
    )
    .join("");
  main.innerHTML = `
    <p class="label">Baralho</p><select id="ed-deck">${deckOptions}</select>
    ${editing ? `<p class="note" style="margin-top:-8px">Tipo: ${h(nt.name)}</p>` : `<p class="label">Tipo</p><select id="ed-type">${typeOptions}</select>`}
    ${fields}
    <p class="label">Etiquetas</p><input type="text" id="ed-tags" value="${h(editor.tags)}" placeholder="separadas por espaço" autocapitalize="none" />
    ${cloze ? `<p class="note">Selecione o trecho a esconder e toque em "Omitir". O resultado fica como {{c1::trecho}}.</p>` : ""}
    ${editing ? `<div class="group"><button class="row danger" data-act="delete-note">Excluir este cartão</button></div>` : ""}`;
  if (editor.values) {
    for (const el of main.querySelectorAll(".field")) {
      const frag = sanitize(editor.values[Number(el.dataset.i)] || "", { keepStyle: false });
      await resolveImages(frag);
      el.append(frag);
    }
  }
  $("#ed-deck").onchange = (e) => (editor.deckId = Number(e.target.value));
  if (!editing) {
    $("#ed-type").onchange = (e) => {
      editor.ntid = Number(e.target.value);
      editor.values = null;
      drawEditor();
    };
  }
}

function fieldHtml(el) {
  const clone = el.cloneNode(true);
  for (const img of clone.querySelectorAll("img[data-fname]")) {
    img.setAttribute("src", img.dataset.fname);
    img.removeAttribute("data-fname");
  }
  const html = clone.innerHTML.replace(/(<br\s*\/?>|\s|&nbsp;)+$/i, "");
  return stripHtml(html) === "" && !/<img|\[sound:/i.test(html) ? "" : html;
}

function insertCloze(index) {
  const el = $(`.field[data-i="${index}"]`);
  const all = [...main.querySelectorAll(".field")].map((f) => f.textContent).join(" ");
  const n = Math.max(0, ...clozeNumbers(all)) + 1;
  const sel = document.getSelection();
  if (savedRange && el.contains(savedRange.commonAncestorContainer)) {
    sel.removeAllRanges();
    sel.addRange(savedRange);
  } else {
    el.focus();
    sel.selectAllChildren(el);
    sel.collapseToEnd();
  }
  const text = sel.toString();
  document.execCommand("insertText", false, `{{c${n}::${text || "texto"}}}`);
}

async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 400000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob || file;
  } catch {
    return file;
  }
}

async function attachImage(file, index) {
  const blob = await shrinkImage(file);
  const ext = blob.type === "image/jpeg" ? "jpg" : (file.name.split(".").pop() || "png").toLowerCase();
  const name = `img-${db.newId()}.${ext}`;
  await db.put("media", { name, type: blob.type || "image/png", data: await blob.arrayBuffer() });
  const img = document.createElement("img");
  img.dataset.fname = name;
  img.src = await mediaUrl(name);
  $(`.field[data-i="${index}"]`)?.append(img);
}

async function saveNote() {
  const nt = state.notetypes.get(editor.ntid);
  const fields = [...main.querySelectorAll(".field")].map(fieldHtml);
  const tags = $("#ed-tags").value.trim().replace(/\s+/g, " ");
  const note = { id: editor.noteId ?? db.newId(), ntid: nt.id, fields, tags };
  const ords = cardOrdsFor(note, nt);
  if (!ords.length) {
    toast(nt.kind === 1 ? 'Marque pelo menos um trecho com "Omitir".' : "Preencha o cartão antes de salvar.");
    return;
  }
  const existing = [...state.cards.values()].filter((c) => c.noteId === note.id);
  const have = new Set(existing.map((c) => c.ord));
  const created = ords
    .filter((ord) => !have.has(ord))
    .map((ord) => {
      const id = db.newId();
      return { id, noteId: note.id, deckId: editor.deckId, ord, ...S.newCardState(id) };
    });
  const moved = existing.filter((c) => c.deckId !== editor.deckId).map((c) => ({ ...c, deckId: editor.deckId }));
  // Em notas de omissão, um número removido do texto leva o cartão junto.
  const removed = nt.kind === 1 ? existing.filter((c) => !ords.includes(c.ord)) : [];

  await db.put("notes", note);
  await db.bulkPut("cards", [...created, ...moved]);
  await db.bulkDel("cards", removed.map((c) => c.id));
  for (const c of [...created, ...moved]) state.cards.set(c.id, c);
  for (const c of removed) state.cards.delete(c.id);
  localStorage.setItem("lastDeck", editor.deckId);

  if (editor.noteId !== null) {
    toast("Cartão salvo.");
    return editor.back();
  }
  localStorage.setItem("lastType", nt.id);
  toast(created.length === 1 ? "Cartão adicionado." : `${created.length} cartões adicionados.`);
  editor.values = null;
  editor.tags = tags;
  await drawEditor();
  $(".field")?.focus();
}

async function deleteNote() {
  if (!confirm("Excluir este cartão? Isso não pode ser desfeito.")) return;
  const cards = [...state.cards.values()].filter((c) => c.noteId === editor.noteId);
  for (const c of cards) state.cards.delete(c.id);
  await db.bulkDel("cards", cards.map((c) => c.id));
  await db.del("notes", editor.noteId);
  if (study?.undo && cards.some((c) => c.id === study.undo.prev.id)) study.undo = null;
  editor.back();
}

// ---------- Lista de cartões ----------

async function showBrowse(deckId) {
  const deck = deckById(deckId);
  if (!deck) return showHome();
  busy("Carregando cartões…");
  try {
    const noteIds = new Set(familyCards(familyIds(deck)).map((c) => c.noteId));
    const notes = (await db.getAll("notes")).filter((n) => noteIds.has(n.id));
    const items = notes.map((n) => {
      const texts = n.fields.map(stripHtml).filter(Boolean);
      return { id: n.id, first: texts[0] || "(sem texto)", second: texts[1] || "", search: `${texts.join(" ")} ${n.tags}`.toLowerCase() };
    });
    browse = { deckId, items, query: browse?.deckId === deckId ? browse.query : "" };
  } finally {
    idle();
  }
  state.view = "home";
  chrome({ title: "Cartões", back: () => showDeck(deckId) });
  main.innerHTML = `<input type="search" id="search" placeholder="Buscar" value="${h(browse.query)}" autocapitalize="none" /><div id="results"></div>`;
  $("#search").oninput = (e) => {
    browse.query = e.target.value;
    drawBrowse();
  };
  drawBrowse();
}

function drawBrowse() {
  const q = browse.query.trim().toLowerCase();
  const found = q ? browse.items.filter((i) => i.search.includes(q)) : browse.items;
  const shown = found.slice(0, 100);
  const rows = shown
    .map(
      (i) => `<button class="row" data-act="edit-note" data-id="${i.id}"><span class="grow">${h(i.first)}<span class="sub">${h(i.second)}</span></span></button>`,
    )
    .join("");
  $("#results").innerHTML = found.length
    ? `<div class="group">${rows}</div><p class="note">${found.length > shown.length ? `Mostrando ${shown.length} de ${found.length}. Use a busca para refinar.` : `${found.length} ${found.length === 1 ? "nota" : "notas"}`}</p>`
    : `<div class="empty"><p>Nenhum cartão encontrado.</p></div>`;
}

// ---------- Ajustes, importação e backup ----------

async function showSettings() {
  state.view = "settings";
  chrome({ title: "Ajustes" });
  let storage = "";
  try {
    const est = await navigator.storage.estimate();
    storage = `${(est.usage / 1048576).toFixed(1)} MB em uso`;
  } catch {
    storage = "";
  }
  if (state.view !== "settings") return;
  main.innerHTML = `
    <p class="label">Estudo diário</p>
    <div class="group">
      <label class="row"><span class="grow">Cartões novos por dia</span><input type="number" id="cfg-new" inputmode="numeric" min="0" max="9999" value="${state.config.newPerDay}" /></label>
      <label class="row"><span class="grow">Revisões por dia</span><input type="number" id="cfg-rev" inputmode="numeric" min="0" max="9999" value="${state.config.revPerDay}" /></label>
      <label class="row"><span class="grow">Tocar áudio automaticamente</span><input type="checkbox" id="cfg-auto" ${state.config.autoplay ? "checked" : ""} /></label>
    </div>
    <p class="note">Os limites valem para cada baralho, somando os seus sub-baralhos.</p>
    <p class="label">Anki</p>
    <div class="group"><button class="row accent" data-act="import">Importar baralho (.apkg)</button></div>
    <p class="note">No Anki do computador: Arquivo → Exportar → "Pacote de baralho do Anki (.apkg)", com mídia incluída. Importar de novo o mesmo baralho atualiza o texto e mantém o seu progresso daqui.</p>
    <p class="label">Backup</p>
    <div class="group">
      <button class="row accent" data-act="export-backup">Salvar backup</button>
      <button class="row accent" data-act="restore-backup">Restaurar backup</button>
    </div>
    <p class="note">Os dados ficam só neste aparelho. Salve um backup de vez em quando: o iOS pode apagar dados de sites que ficam muito tempo sem uso.</p>
    <p class="label">Dados</p>
    <div class="group">
      <div class="row"><span class="grow">Cartões</span><span class="sub">${state.cards.size}</span></div>
      <div class="row"><span class="grow">Armazenamento</span><span class="sub">${storage}</span></div>
      <button class="row danger" data-act="wipe">Apagar todos os dados</button>
    </div>`;
  const number = (el, key) => {
    el.onchange = () => {
      const v = Math.max(0, Math.min(9999, Math.round(Number(el.value)) || 0));
      el.value = v;
      state.config[key] = v;
      saveConfig();
    };
  };
  number($("#cfg-new"), "newPerDay");
  number($("#cfg-rev"), "revPerDay");
  $("#cfg-auto").onchange = (e) => {
    state.config.autoplay = e.target.checked;
    saveConfig();
  };
}

async function importApkg(file) {
  busy("Lendo o pacote…");
  try {
    await nextFrame();
    const libs = await loadApkgLibs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pkg = parseApkg(bytes, libs);

    busy(`Importando ${pkg.cards.length} cartões…`);
    await nextFrame();
    const knownDecks = new Set(state.decks.map((d) => d.id));
    const newCards = pkg.cards.filter((c) => !state.cards.has(c.id));
    await db.bulkPut("decks", pkg.decks.filter((d) => !knownDecks.has(d.id)));
    await db.bulkPut("notetypes", pkg.notetypes);
    for (let i = 0; i < pkg.notes.length; i += 2000) await db.bulkPut("notes", pkg.notes.slice(i, i + 2000));
    for (let i = 0; i < newCards.length; i += 2000) await db.bulkPut("cards", newCards.slice(i, i + 2000));

    let mediaDone = 0;
    for (let i = 0; i < pkg.media.length; i += 40) {
      busy(`Importando mídia… ${mediaDone} de ${pkg.media.length}`);
      await nextFrame();
      const files = pkg.extractMedia(pkg.media.slice(i, i + 40));
      await db.bulkPut("media", files);
      mediaDone += files.length;
    }

    await loadState();
    const kept = pkg.cards.length - newCards.length;
    idle();
    showHome();
    alert(
      `Importação concluída.\n\n${pkg.notes.length} notas\n${newCards.length} cartões novos` +
        (kept ? `\n${kept} cartões que já existiam (progresso mantido)` : "") +
        `\n${mediaDone} arquivos de mídia`,
    );
  } catch (err) {
    idle();
    console.error(err);
    alert(`Não foi possível importar.\n\n${err.message || err}`);
  }
}

async function exportBackup() {
  busy("Preparando o backup…");
  try {
    await nextFrame();
    const file = await buildBackup();
    idle();
    await deliverFile(file);
  } catch (err) {
    idle();
    alert(`Não foi possível criar o backup.\n\n${err.message || err}`);
  }
}

async function restoreBackup(file) {
  busy("Lendo o backup…");
  try {
    await nextFrame();
    const backup = await readBackup(new Uint8Array(await file.arrayBuffer()));
    idle();
    const when = new Date(backup.data.exportedAt).toLocaleString("pt-BR");
    if (!confirm(`Restaurar o backup de ${when}?\n\nIsso substitui TODOS os dados atuais deste aparelho (${state.cards.size} cartões) pelos ${backup.data.cards.length} cartões do backup.`)) return;
    busy("Restaurando…");
    await applyBackup(backup);
    await loadState();
    idle();
    showHome();
    toast("Backup restaurado.");
  } catch (err) {
    idle();
    alert(`Não foi possível restaurar.\n\n${err.message || err}`);
  }
}

async function wipe() {
  if (!confirm(`Apagar todos os ${state.cards.size} cartões, baralhos, mídias e o histórico deste aparelho? Isso não pode ser desfeito.`)) return;
  await db.clearAll();
  await loadState();
  showHome();
  toast("Dados apagados.");
}

// ---------- Eventos ----------

const actions = {
  back: () => state.onBack?.(),
  nav: (el) => {
    study = null;
    if (el.dataset.view === "home") showHome();
    else if (el.dataset.view === "add") showEditor({ back: null });
    else showSettings();
  },
  "hide-hint": () => {
    localStorage.setItem("hideInstallHint", "1");
    showHome();
  },
  "new-deck": async () => {
    if (await createDeck()) showHome();
  },
  "open-deck": (el) => showDeck(Number(el.dataset.id)),
  "rename-deck": (el) => renameDeck(Number(el.dataset.id)),
  "delete-deck": (el) => deleteDeck(Number(el.dataset.id)),
  study: (el) => startStudy(Number(el.dataset.id)),
  "show-answer": () => {
    study.shown = true;
    drawStudy();
  },
  rate: (el) => rate(Number(el.dataset.r)),
  undo: undoAnswer,
  "skip-broken": skipBroken,
  "edit-current": () => {
    if (!study?.current) return;
    const session = study;
    stopAudio();
    showEditor({
      noteId: study.current.noteId,
      back: () => {
        // Volta para a mesma sessão; o cartão pode ter mudado ou sido excluído.
        startStudy(session.deckId);
      },
    });
  },
  "add-to": (el) => {
    const id = Number(el.dataset.id);
    showEditor({ deckId: id, back: () => showDeck(id) });
  },
  browse: (el) => showBrowse(Number(el.dataset.id)),
  "edit-note": (el) => {
    const deckId = browse.deckId;
    showEditor({ noteId: Number(el.dataset.id), back: () => showBrowse(deckId) });
  },
  "save-note": saveNote,
  "delete-note": deleteNote,
  cloze: (el) => insertCloze(Number(el.dataset.i)),
  "pick-image": (el) => {
    const input = $("#file-image");
    input.dataset.i = el.dataset.i;
    input.click();
  },
  import: () => $("#file-apkg").click(),
  "export-backup": exportBackup,
  "restore-backup": () => $("#file-backup").click(),
  wipe,
};

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-act]");
  if (!el || el.disabled) return;
  Promise.resolve(actions[el.dataset.act]?.(el)).catch((err) => {
    console.error(err);
    idle();
    toast(`Erro: ${err.message || err}`, 5000);
  });
});

function onFile(selector, handler) {
  $(selector).addEventListener("change", (event) => {
    const input = event.target;
    const file = input.files[0];
    const index = input.dataset.i;
    input.value = "";
    if (file) handler(file, index);
  });
}

onFile("#file-apkg", importApkg);
onFile("#file-backup", restoreBackup);
onFile("#file-image", (file, index) => attachImage(file, index).catch((err) => toast(`Erro: ${err.message}`)));

document.addEventListener("keydown", (event) => {
  if (state.view !== "study" || !study?.current || event.target.closest("input,select,[contenteditable]")) return;
  if (!study.shown && (event.key === " " || event.key === "Enter")) {
    event.preventDefault();
    actions["show-answer"]();
  } else if (study.shown && (event.key === " " || event.key === "Enter")) {
    event.preventDefault();
    rate(S.GOOD);
  } else if (study.shown && ["1", "2", "3", "4"].includes(event.key)) {
    rate(Number(event.key));
  }
});

// Ao voltar para o app (por exemplo no dia seguinte), as contagens são recalculadas.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.view === "home" && !state.onBack) showHome();
});

async function boot() {
  try {
    await loadState();
  } catch (err) {
    main.innerHTML = `<div class="empty"><h2>Não foi possível abrir os dados</h2><p>${h(err.message || err)}</p><p>Se o Safari estiver em navegação privada, abra em uma aba normal.</p></div>`;
    return;
  }
  showHome();
  navigator.storage?.persist?.().catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
