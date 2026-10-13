// Backup completo em um arquivo .zip: dados em backup.json e as mídias em media/.

import * as db from "./db.js";
import { loadZip } from "./libs.js";

const FORMAT = "flashcards-backup";
const DATA_STORES = ["decks", "notetypes", "notes", "cards", "revlog", "meta"];

export async function buildBackup() {
  const { zipSync, strToU8 } = await loadZip();
  const data = { format: FORMAT, version: 1, exportedAt: new Date().toISOString() };
  for (const store of DATA_STORES) data[store] = await db.getAll(store);
  const media = await db.getAll("media");
  data.media = media.map((m) => ({ name: m.name, type: m.type }));

  const files = { "backup.json": strToU8(JSON.stringify(data)) };
  // Mídia já é comprimida (jpg, mp3...); guardar sem recomprimir é mais rápido.
  for (const m of media) files[`media/${m.name}`] = [new Uint8Array(m.data), { level: 0 }];
  const stamp = new Date().toISOString().slice(0, 10);
  return new File([zipSync(files)], `flashcards-backup-${stamp}.zip`, { type: "application/zip" });
}

export async function readBackup(bytes) {
  const { unzipSync, strFromU8 } = await loadZip();
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("Este arquivo não é um backup válido.");
  }
  if (!files["backup.json"]) throw new Error("Este arquivo não é um backup deste app.");
  const data = JSON.parse(strFromU8(files["backup.json"]));
  if (data.format !== FORMAT) throw new Error("Este arquivo não é um backup deste app.");
  if (data.version !== 1) throw new Error("Backup de uma versão mais nova do app.");
  const media = (data.media || [])
    .filter((m) => files[`media/${m.name}`])
    .map((m) => ({ name: m.name, type: m.type, data: files[`media/${m.name}`].slice().buffer }));
  return { data, media };
}

// Substitui tudo o que existe no aparelho pelo conteúdo do backup.
export async function applyBackup({ data, media }) {
  await db.clearAll();
  for (const store of DATA_STORES) await db.bulkPut(store, data[store] || []);
  for (let i = 0; i < media.length; i += 50) await db.bulkPut("media", media.slice(i, i + 50));
}

export async function deliverFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
