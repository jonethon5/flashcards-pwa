// Lê pacotes do Anki (.apkg / .colpkg), nos formatos antigo e atual.
// As bibliotecas chegam por parâmetro para o mesmo código rodar no navegador e nos testes.

import { fromAnki } from "./scheduler.js";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const COLLECTION_FILES = ["collection.anki21b", "collection.anki21", "collection.anki2"];

const MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function mimeFor(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

function isZstd(bytes) {
  return ZSTD_MAGIC.every((b, i) => bytes[i] === b);
}

// Leitor mínimo de protobuf: devolve os campos de primeiro nível de uma mensagem.
export function readProto(bytes) {
  const fields = [];
  let pos = 0;
  const varint = () => {
    let result = 0;
    let shift = 1;
    for (;;) {
      if (pos >= bytes.length) throw new Error("Dados protobuf truncados");
      const b = bytes[pos++];
      result += (b & 0x7f) * shift;
      shift *= 128;
      if (!(b & 0x80)) return result;
    }
  };
  while (pos < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) fields.push({ field, value: varint() });
    else if (wire === 2) {
      const len = varint();
      fields.push({ field, value: bytes.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error("Formato protobuf não suportado");
  }
  return fields;
}

const utf8 = new TextDecoder("utf-8");

function protoString(fields, number) {
  const f = fields.find((x) => x.field === number && x.value instanceof Uint8Array);
  return f ? utf8.decode(f.value) : "";
}

function protoNumber(fields, number) {
  const f = fields.find((x) => x.field === number && typeof x.value === "number");
  return f ? f.value : 0;
}

function rows(db, sql) {
  const out = [];
  const stmt = db.prepare(sql);
  try {
    while (stmt.step()) out.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return out;
}

function hasTable(db, name) {
  const stmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  try {
    stmt.bind([name]);
    return stmt.step();
  } finally {
    stmt.free();
  }
}

function readLegacyModels(db) {
  const col = rows(db, "SELECT crt, models, decks FROM col")[0];
  const notetypes = Object.values(JSON.parse(col.models || "{}")).map((m) => ({
    id: Number(m.id),
    name: m.name,
    kind: m.type === 1 ? 1 : 0,
    css: m.css || "",
    fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
    templates: [...m.tmpls]
      .sort((a, b) => a.ord - b.ord)
      .map((t) => ({ name: t.name, q: t.qfmt, a: t.afmt })),
  }));
  const decks = Object.values(JSON.parse(col.decks || "{}")).map((d) => ({
    id: Number(d.id),
    name: d.name,
  }));
  return { crt: col.crt, notetypes, decks };
}

function readCurrentModels(db) {
  const crt = rows(db, "SELECT crt FROM col")[0].crt;
  const byId = new Map();
  for (const r of rows(db, "SELECT id, name, config FROM notetypes")) {
    const cfg = readProto(r.config);
    byId.set(r.id, {
      id: r.id,
      name: r.name,
      kind: protoNumber(cfg, 1) === 1 ? 1 : 0,
      css: protoString(cfg, 3),
      fields: [],
      templates: [],
    });
  }
  for (const r of rows(db, "SELECT ntid, ord, name FROM fields")) {
    const nt = byId.get(r.ntid);
    if (nt) nt.fields[r.ord] = r.name;
  }
  for (const r of rows(db, "SELECT ntid, ord, name, config FROM templates")) {
    const nt = byId.get(r.ntid);
    if (!nt) continue;
    const cfg = readProto(r.config);
    nt.templates[r.ord] = { name: r.name, q: protoString(cfg, 1), a: protoString(cfg, 2) };
  }
  const notetypes = [...byId.values()].map((nt) => ({
    ...nt,
    fields: nt.fields.filter((f) => f !== undefined),
    templates: nt.templates.filter((t) => t !== undefined),
  }));
  const decks = rows(db, "SELECT id, name FROM decks").map((d) => ({
    id: d.id,
    name: String(d.name).split("\x1f").join("::"),
  }));
  return { crt, notetypes, decks };
}

function readMediaMap(bytes, zstd) {
  if (!bytes || !bytes.length) return [];
  if (!isZstd(bytes)) {
    const map = JSON.parse(utf8.decode(bytes) || "{}");
    return Object.entries(map).map(([zipName, name]) => ({ zipName, name }));
  }
  // Formato atual: lista protobuf, em que a posição da entrada é o nome do arquivo no zip.
  return readProto(zstd(bytes))
    .filter((f) => f.field === 1)
    .map((entry, index) => ({ zipName: String(index), name: protoString(readProto(entry.value), 1) }));
}

/**
 * @param {Uint8Array} bytes conteúdo do arquivo .apkg
 * @param {{SQL: any, unzipSync: Function, zstdDecompress: Function}} libs
 */
export function parseApkg(bytes, libs, now = Date.now()) {
  const wanted = new Set([...COLLECTION_FILES, "media"]);
  let head;
  try {
    head = libs.unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
  } catch {
    throw new Error("Este arquivo não é um pacote do Anki válido (.apkg).");
  }
  const colName = COLLECTION_FILES.find((n) => head[n]);
  if (!colName) throw new Error("O pacote não contém uma coleção do Anki.");
  let colBytes = head[colName];
  if (isZstd(colBytes)) colBytes = libs.zstdDecompress(colBytes);

  const db = new libs.SQL.Database(colBytes);
  let models;
  let noteRows;
  let cardRows;
  try {
    models = hasTable(db, "notetypes") ? readCurrentModels(db) : readLegacyModels(db);
    noteRows = rows(db, "SELECT id, mid, tags, flds FROM notes");
    cardRows = rows(
      db,
      "SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, odue, odid FROM cards",
    );
  } finally {
    db.close();
  }

  const notes = noteRows.map((n) => ({
    id: n.id,
    ntid: n.mid,
    tags: String(n.tags || "").trim(),
    fields: String(n.flds).split("\x1f"),
  }));
  const cards = cardRows.map((c) => ({
    id: c.id,
    noteId: c.nid,
    deckId: c.odid ? c.odid : c.did,
    ord: c.ord,
    ...fromAnki(c, models.crt, now),
  }));

  const usedDecks = new Set(cards.map((c) => c.deckId));
  const usedTypes = new Set(notes.map((n) => n.ntid));
  const media = readMediaMap(head.media, libs.zstdDecompress).filter((m) => m.name);

  return {
    decks: models.decks.filter((d) => usedDecks.has(d.id)),
    notetypes: models.notetypes.filter((t) => usedTypes.has(t.id)),
    notes,
    cards,
    media,
    // Extrai um lote de mídias por vez, para não estourar a memória do celular.
    extractMedia(batch) {
      const names = new Map(batch.map((m) => [m.zipName, m.name]));
      const files = libs.unzipSync(bytes, { filter: (f) => names.has(f.name) });
      return Object.entries(files).map(([zipName, data]) => {
        const name = names.get(zipName).normalize("NFC");
        const raw = isZstd(data) ? libs.zstdDecompress(data) : data;
        // Copia para um buffer próprio: o IndexedDB guardaria o buffer inteiro do zip.
        return { name, type: mimeFor(name), data: raw.slice().buffer };
      });
    },
  };
}
