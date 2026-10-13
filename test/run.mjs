// Testes sem navegador: node test/run.mjs [caminho-de-uma-colecao-do-anki]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { unzipSync, zipSync, strToU8 } from "../vendor/fflate.js";
import { decompress as zstdDecompress } from "../vendor/fzstd.js";
import { parseApkg, readProto } from "../js/importer.js";
import { renderCard, renderCloze, cardOrdsFor, builtinNotetypes, stripHtml } from "../js/render.js";
import * as S from "../js/scheduler.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const SQL = await require("../vendor/sql-wasm.js")({
  locateFile: (f) => join(root, "vendor", f),
});
const libs = { SQL, unzipSync, zstdDecompress };

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime();
const cfg = S.DEFAULT_CONFIG;

test("cartão novo passa pelas etapas e se forma em 1 dia", () => {
  let c = { id: 1, ...S.newCardState() };
  c = S.answer(c, S.GOOD, NOW, cfg);
  assert.equal(c.state, "learn");
  assert.equal(c.due, NOW + 10 * S.MIN);
  c = S.answer(c, S.GOOD, NOW, cfg);
  assert.equal(c.state, "review");
  assert.equal(c.ivl, 1);
  assert.equal(c.ease, 2.5);
  assert.equal(c.due, S.dayStart(NOW) + S.DAY);
});

test("fácil em cartão novo pula para 4 dias", () => {
  const c = S.answer({ id: 1, ...S.newCardState() }, S.EASY, NOW, cfg);
  assert.equal(c.state, "review");
  assert.equal(c.ivl, 4);
});

test("revisão: difícil < bom < fácil, e errar reaprende", () => {
  const card = { id: 1, state: "review", due: S.dayStart(NOW), ivl: 10, ease: 2.5, step: 0, reps: 5, lapses: 0, pos: 0 };
  const hard = S.answer(card, S.HARD, NOW, cfg);
  const good = S.answer(card, S.GOOD, NOW, cfg);
  const easy = S.answer(card, S.EASY, NOW, cfg);
  assert.equal(hard.ivl, 12);
  assert.equal(good.ivl, 25);
  assert.equal(easy.ivl, 33);
  assert.ok(hard.ease < good.ease && good.ease < easy.ease);
  const again = S.answer(card, S.AGAIN, NOW, cfg);
  assert.equal(again.state, "relearn");
  assert.equal(again.lapses, 1);
  assert.equal(again.ease, 2.3);
  const back = S.answer(again, S.GOOD, NOW, cfg);
  assert.equal(back.state, "review");
  assert.equal(back.ivl, 1);
});

test("o dia de estudo vira às 4h", () => {
  const at3 = new Date(2026, 9, 13, 3, 0).getTime();
  const at5 = new Date(2026, 9, 13, 5, 0).getTime();
  assert.equal(S.dayStart(at5) - S.dayStart(at3), S.DAY);
});

test("filas respeitam limites diários e priorizam aprendizado vencido", () => {
  const cards = [];
  for (let i = 0; i < 30; i++) cards.push({ id: i, ...S.newCardState(i) });
  for (let i = 100; i < 110; i++)
    cards.push({ id: i, state: "review", due: S.dayStart(NOW), ivl: 3, ease: 2.5, step: 0, reps: 1, lapses: 0, pos: 0 });
  cards.push({ id: 200, state: "review", due: S.dayStart(NOW) + S.DAY, ivl: 3, ease: 2.5, step: 0, reps: 1, lapses: 0, pos: 0 });
  cards.push({ id: 300, state: "learn", due: NOW - 1000, ivl: 0, ease: 0, step: 0, reps: 1, lapses: 0, pos: 0 });
  cards.push({ id: 400, ...S.newCardState(0), suspended: true });
  const q = S.buildQueues(cards, NOW, cfg, { new: 5, review: 0 });
  assert.equal(q.new.length, 15);
  assert.equal(q.review.length, 10);
  assert.equal(q.learn.length, 1);
  assert.equal(S.nextCard(q, NOW).id, 300);
});

test("rótulos de intervalo", () => {
  const c = { id: 1, ...S.newCardState() };
  assert.equal(S.intervalLabel(c, S.AGAIN, NOW, cfg), "1 min");
  assert.equal(S.intervalLabel(c, S.GOOD, NOW, cfg), "10 min");
  assert.equal(S.intervalLabel(c, S.EASY, NOW, cfg), "4 d");
  assert.equal(S.formatDays(45), "1,5 mês");
});

const [basic, reversed, cloze] = builtinNotetypes();

test("modelo básico renderiza frente e verso", () => {
  const note = { fields: ["Capital da França?", "Paris"], tags: "" };
  const r = renderCard({ ord: 0 }, note, basic);
  assert.equal(r.q, "Capital da França?");
  assert.equal(r.a, 'Capital da França?<hr id="answer">Paris');
});

test("omissão: pergunta esconde, resposta mostra, com dica e aninhamento", () => {
  assert.equal(renderCloze("{{c1::Paris::cidade}} fica na {{c2::França}}", 1, "q"), '<span class="cloze">[cidade]</span> fica na França');
  assert.equal(renderCloze("{{c1::Paris}} fica na {{c2::França}}", 2, "a"), 'Paris fica na <span class="cloze">França</span>');
  assert.equal(renderCloze("{{c1::a {{c2::b}} c}}", 1, "q"), '<span class="cloze">[...]</span>');
  const note = { fields: ["{{c1::A}} e {{c3::B}}", ""], tags: "" };
  assert.deepEqual(cardOrdsFor(note, cloze), [0, 2]);
});

test("condicionais, filtros e áudio", () => {
  const nt = {
    name: "T",
    kind: 0,
    css: "",
    fields: ["A", "B"],
    templates: [{ name: "c", q: "{{A}}{{#B}} [{{text:B}}]{{/B}}{{^B}} vazio{{/B}}", a: "{{FrontSide}}|{{hint:B}}" }],
  };
  assert.equal(renderCard({ ord: 0 }, { fields: ["x", ""], tags: "" }, nt).q, "x vazio");
  const r = renderCard({ ord: 0 }, { fields: ["x[sound:a.mp3]", "<b>y</b>"], tags: "" }, nt);
  assert.ok(r.q.includes('data-snd="a.mp3"') && r.q.endsWith(" [y]"));
  assert.ok(r.a.split("|")[0].includes('data-snd="a.mp3" data-quiet="1"'));
  assert.ok(r.a.includes("<details"));
  assert.deepEqual(cardOrdsFor({ fields: ["", "y"] }, reversed), [1]);
  assert.deepEqual(cardOrdsFor({ fields: ["x", "y"] }, reversed), [0, 1]);
  assert.equal(stripHtml("<div>a<br>b</div>&amp;"), "a b &");
});

// --- Pacotes sintéticos ---------------------------------------------------

const CRT = Math.floor(new Date(2026, 0, 1, 4).getTime() / 1000);
const todayIdx = Math.floor((NOW / 1000 - CRT) / 86400);

function legacyCollection() {
  const db = new SQL.Database();
  db.run("CREATE TABLE col (crt integer, models text, decks text)");
  db.run("CREATE TABLE notes (id integer primary key, mid integer, tags text, flds text)");
  db.run(
    "CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, odue integer, odid integer)",
  );
  const models = {
    1500: { id: 1500, name: "Basic", type: 0, css: ".card{color:red}", flds: [{ name: "Back", ord: 1 }, { name: "Front", ord: 0 }], tmpls: [{ name: "Card 1", ord: 0, qfmt: "{{Front}}", afmt: "{{Back}}" }] },
    1600: { id: 1600, name: "Unused", type: 0, css: "", flds: [], tmpls: [] },
  };
  const decks = { 1: { id: 1, name: "Default" }, 77: { id: 77, name: "Idiomas::Inglês" } };
  db.run("INSERT INTO col VALUES (?, ?, ?)", [CRT, JSON.stringify(models), JSON.stringify(decks)]);
  db.run("INSERT INTO notes VALUES (10, 1500, ' verbo ', ?)", ['dog <img src="dog.png">\x1fcachorro']);
  db.run("INSERT INTO notes VALUES (11, 1500, '', ?)", ["cat\x1fgato"]);
  db.run("INSERT INTO cards VALUES (20, 10, 77, 0, 2, 2, ?, 12, 2300, 4, 1, 0, 0)", [todayIdx + 3]);
  db.run("INSERT INTO cards VALUES (21, 11, 77, 0, 0, -1, 7, 0, 0, 0, 0, 0, 0)");
  const bytes = db.export();
  db.close();
  return bytes;
}

test("importa pacote no formato antigo", () => {
  const apkg = zipSync({
    "collection.anki2": legacyCollection(),
    media: strToU8(JSON.stringify({ 0: "dog.png" })),
    0: new Uint8Array([137, 80, 78, 71]),
  });
  const r = parseApkg(apkg, libs, NOW);
  assert.deepEqual(r.decks, [{ id: 77, name: "Idiomas::Inglês" }]);
  assert.equal(r.notetypes.length, 1);
  assert.deepEqual(r.notetypes[0].fields, ["Front", "Back"]);
  assert.equal(r.notes[0].tags, "verbo");
  const review = r.cards.find((c) => c.id === 20);
  assert.equal(review.state, "review");
  assert.equal(review.ivl, 12);
  assert.equal(review.ease, 2.3);
  assert.equal(review.due, S.dayStart(NOW) + 3 * S.DAY);
  const fresh = r.cards.find((c) => c.id === 21);
  assert.equal(fresh.state, "new");
  assert.equal(fresh.pos, 7);
  assert.equal(fresh.suspended, true);
  const media = r.extractMedia(r.media);
  assert.equal(media[0].name, "dog.png");
  assert.equal(media[0].type, "image/png");
  assert.equal(media[0].data.byteLength, 4);
});

function protoField(number, payload) {
  const body = typeof payload === "string" ? strToU8(payload) : payload;
  assert.ok(body.length < 128 && number < 16);
  return new Uint8Array([number * 8 + 2, body.length, ...body]);
}

test("importa mídia e coleção comprimidas do formato atual", () => {
  const entry = protoField(1, "áudio.mp3");
  const mediaList = protoField(1, entry);
  assert.equal(readProto(mediaList).length, 1);
  const apkg = zipSync({
    "collection.anki21b": new Uint8Array(zstdCompressSync(legacyCollection())),
    "collection.anki2": new Uint8Array([0]),
    media: new Uint8Array(zstdCompressSync(mediaList)),
    0: new Uint8Array(zstdCompressSync(new Uint8Array([1, 2, 3]))),
  });
  const r = parseApkg(apkg, libs, NOW);
  assert.equal(r.cards.length, 2);
  const media = r.extractMedia(r.media);
  assert.equal(media[0].name, "áudio.mp3");
  assert.deepEqual([...new Uint8Array(media[0].data)], [1, 2, 3]);
});

test("recusa arquivo que não é pacote do Anki", () => {
  assert.throws(() => parseApkg(strToU8("isso não é um zip"), libs, NOW), /não é um pacote/);
});

// --- Coleção real, opcional -------------------------------------------------

const realPath = process.argv[2];
if (realPath) {
  const apkg = zipSync({ "collection.anki21": new Uint8Array(readFileSync(realPath)) }, { level: 0 });
  const r = parseApkg(apkg, libs);
  const byState = {};
  for (const c of r.cards) byState[c.state] = (byState[c.state] || 0) + 1;
  console.log("\nColeção real:");
  console.log(`  baralhos: ${r.decks.map((d) => d.name).join(" | ")}`);
  for (const t of r.notetypes)
    console.log(`  tipo: ${t.name} (kind ${t.kind}) campos=[${t.fields.join(", ")}] modelos=${t.templates.length} css=${t.css.length}b`);
  console.log(`  notas: ${r.notes.length}  cartões: ${r.cards.length}  ${JSON.stringify(byState)}`);
  const types = new Map(r.notetypes.map((t) => [t.id, t]));
  const notes = new Map(r.notes.map((n) => [n.id, n]));
  let empty = 0;
  for (const c of r.cards) {
    const note = notes.get(c.noteId);
    const out = renderCard(c, note, types.get(note.ntid));
    if (!stripHtml(out.q) && !/<img|data-snd/.test(out.q)) empty++;
  }
  console.log(`  cartões com pergunta vazia após renderizar: ${empty}`);
  const sample = r.cards[0];
  if (sample) {
    const note = notes.get(sample.noteId);
    const out = renderCard(sample, note, types.get(note.ntid));
    console.log(`  exemplo P: ${stripHtml(out.q).slice(0, 80)}`);
    console.log(`  exemplo R: ${stripHtml(out.a).slice(0, 80)}`);
  }
}

console.log(`\n${passed} testes passaram`);
