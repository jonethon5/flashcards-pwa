// Transforma os modelos de cartão do Anki (campos, condicionais, omissões) em HTML.

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function stripHtml(html) {
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/div>|<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\[sound:[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Um campo conta como vazio se não tiver texto nem mídia.
function isEmptyField(value) {
  if (!value) return true;
  if (/<img|\[sound:/i.test(value)) return false;
  return stripHtml(value) === "";
}

const CLOZE_RE = /\{\{c(\d+)::((?:(?!\{\{c\d+::)[\s\S])*?)\}\}/;

export function clozeNumbers(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/\{\{c(\d+)::/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

// Resolve as omissões de dentro para fora, para aceitar omissões aninhadas.
export function renderCloze(text, number, side) {
  let out = String(text);
  for (let guard = 0; guard < 500; guard++) {
    const m = CLOZE_RE.exec(out);
    if (!m) break;
    const sep = m[2].indexOf("::");
    const content = sep === -1 ? m[2] : m[2].slice(0, sep);
    const hint = sep === -1 ? "" : m[2].slice(sep + 2);
    let replacement = content;
    if (Number(m[1]) === number) {
      replacement =
        side === "q"
          ? `<span class="cloze">[${hint || "..."}]</span>`
          : `<span class="cloze">${content}</span>`;
    }
    out = out.slice(0, m.index) + replacement + out.slice(m.index + m[0].length);
  }
  return out;
}

function furigana(text, mode) {
  return text.replace(/ ?([^ >\[\]]+?)\[([^\]]*?)\]/g, (all, base, reading) => {
    if (reading.startsWith("sound:")) return all;
    if (mode === "kanji") return base;
    if (mode === "kana") return reading;
    return `<ruby>${base}<rt>${reading}</rt></ruby>`;
  });
}

function applyFilter(name, value, ctx) {
  switch (name) {
    case "text":
      return escapeHtml(stripHtml(value));
    case "cloze":
      return renderCloze(value, ctx.ord + 1, ctx.side);
    case "hint":
      return isEmptyField(value)
        ? ""
        : `<details class="hint"><summary>${escapeHtml(ctx.fieldName)}</summary>${value}</details>`;
    case "furigana":
    case "kanji":
    case "kana":
      return furigana(value, name);
    case "type":
      return ctx.side === "a" ? value : "";
    default:
      // Filtros de voz (tts) e desconhecidos não produzem saída útil aqui.
      return name.startsWith("tts") ? "" : value;
  }
}

function renderTemplate(template, ctx) {
  let out = template;

  // Condicionais {{#Campo}}...{{/Campo}} e {{^Campo}}...{{/Campo}}
  const cond = /\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
  for (let guard = 0; guard < 500; guard++) {
    const m = cond.exec(out);
    if (!m) break;
    const key = m[2];
    let empty;
    const clozeKey = /^c(\d+)$/.exec(key);
    if (clozeKey && !(key in ctx.fields)) empty = Number(clozeKey[1]) !== ctx.ord + 1;
    else empty = isEmptyField(ctx.fields[key]);
    const show = m[1] === "#" ? !empty : empty;
    out = out.slice(0, m.index) + (show ? m[3] : "") + out.slice(m.index + m[0].length);
  }

  return out.replace(/\{\{([^{}]*)\}\}/g, (all, inner) => {
    const expr = inner.trim();
    if (!expr || expr.startsWith("!") || expr.startsWith("=")) return "";
    if (/^c\d+::/.test(expr)) return all;
    const parts = expr.split(":").map((p) => p.trim());
    const fieldName = parts[parts.length - 1];
    let value;
    if (fieldName === "FrontSide") value = ctx.frontSide || "";
    else if (fieldName === "Tags") value = escapeHtml(ctx.tags || "");
    else if (fieldName === "Deck") value = escapeHtml(ctx.deck || "");
    else if (fieldName === "Subdeck") value = escapeHtml((ctx.deck || "").split("::").pop());
    else if (fieldName === "Card") value = escapeHtml(ctx.cardName || "");
    else if (fieldName === "Type") value = escapeHtml(ctx.typeName || "");
    else if (fieldName === "CardFlag") value = "";
    else if (fieldName in ctx.fields) value = ctx.fields[fieldName];
    else return `<span class="missing">{campo desconhecido: ${escapeHtml(fieldName)}}</span>`;
    for (let i = parts.length - 2; i >= 0; i--) {
      value = applyFilter(parts[i].split(" ")[0], value, { ...ctx, fieldName });
    }
    return value;
  });
}

// Troca [sound:arquivo] por um botão; as imagens são resolvidas depois, já no DOM.
// O áudio vindo de {{FrontSide}} ganha data-quiet: aparece na resposta, mas não toca sozinho de novo.
function soundButtons(html) {
  return html.replace(
    /\[(f?)sound:([^\]]+)\]/g,
    (all, front, name) =>
      `<button type="button" class="snd" data-snd="${escapeHtml(name)}"${front ? ' data-quiet="1"' : ""} aria-label="Tocar áudio">▶</button>`,
  );
}

export function fieldMap(note, notetype) {
  const fields = {};
  notetype.fields.forEach((name, i) => (fields[name] = note.fields[i] || ""));
  return fields;
}

function templateFor(notetype, ord) {
  // Tipos de omissão têm um único modelo, usado por todos os cartões da nota.
  if (notetype.kind === 1) return notetype.templates[0];
  return notetype.templates[ord] || notetype.templates[0];
}

export function renderCard(card, note, notetype, deckName = "") {
  const tmpl = templateFor(notetype, card.ord);
  if (!tmpl) return { q: "", a: "", css: notetype.css || "" };
  const ctx = {
    fields: fieldMap(note, notetype),
    ord: card.ord,
    tags: (note.tags || "").trim(),
    deck: deckName,
    cardName: tmpl.name,
    typeName: notetype.name,
  };
  const q = renderTemplate(tmpl.q, { ...ctx, side: "q" });
  const frontSide = q.replace(/\[sound:/g, "[fsound:");
  const a = renderTemplate(tmpl.a, { ...ctx, side: "a", frontSide });
  return { q: soundButtons(q), a: soundButtons(a), css: notetype.css || "" };
}

// Ordinais dos cartões que uma nota deve ter.
export function cardOrdsFor(note, notetype) {
  if (notetype.kind === 1) {
    const ords = new Set();
    for (const value of note.fields) for (const n of clozeNumbers(value)) ords.add(n - 1);
    return [...ords].sort((a, b) => a - b);
  }
  const fields = fieldMap(note, notetype);
  const blank = Object.fromEntries(notetype.fields.map((name) => [name, ""]));
  const ords = [];
  notetype.templates.forEach((tmpl, ord) => {
    const base = { ord, side: "q", tags: "", deck: "", cardName: tmpl.name, typeName: notetype.name };
    const filled = renderTemplate(tmpl.q, { ...base, fields });
    const empty = renderTemplate(tmpl.q, { ...base, fields: blank });
    if (filled !== empty) ords.push(ord);
  });
  return ords;
}

export const BUILTIN_CSS = `.card {
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 22px;
  text-align: center;
  color: black;
  background-color: white;
}
.cloze { font-weight: bold; color: #0a58ca; }
.nightMode .cloze { color: #7ab8ff; }`;

export const BUILTIN_IDS = { basic: 1, reversed: 2, cloze: 3 };

export function builtinNotetypes() {
  const front = "{{Frente}}";
  const back = '{{FrontSide}}<hr id="answer">{{Verso}}';
  return [
    {
      id: BUILTIN_IDS.basic,
      name: "Básico",
      kind: 0,
      css: BUILTIN_CSS,
      fields: ["Frente", "Verso"],
      templates: [{ name: "Cartão 1", q: front, a: back }],
    },
    {
      id: BUILTIN_IDS.reversed,
      name: "Básico (com cartão invertido)",
      kind: 0,
      css: BUILTIN_CSS,
      fields: ["Frente", "Verso"],
      templates: [
        { name: "Cartão 1", q: front, a: back },
        { name: "Cartão 2", q: "{{Verso}}", a: '{{FrontSide}}<hr id="answer">{{Frente}}' },
      ],
    },
    {
      id: BUILTIN_IDS.cloze,
      name: "Omissão de palavras",
      kind: 1,
      css: BUILTIN_CSS,
      fields: ["Texto", "Extra"],
      templates: [{ name: "Omissão", q: "{{cloze:Texto}}", a: "{{cloze:Texto}}<br>{{Extra}}" }],
    },
  ];
}
