// Carrega as bibliotecas pesadas só quando são necessárias (importar pacotes e backups).

let zipLib = null;
let apkgLibs = null;

export function loadZip() {
  zipLib ??= import("../vendor/fflate.js");
  return zipLib;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Não foi possível carregar ${src}`));
    document.head.append(el);
  });
}

export function loadApkgLibs() {
  apkgLibs ??= (async () => {
    const vendor = new URL("../vendor/", import.meta.url);
    const [zip, zstd] = await Promise.all([loadZip(), import("../vendor/fzstd.js")]);
    if (!globalThis.initSqlJs) await loadScript(new URL("sql-wasm.js", vendor).href);
    const SQL = await globalThis.initSqlJs({ locateFile: (file) => new URL(file, vendor).href });
    return { SQL, unzipSync: zip.unzipSync, zstdDecompress: zstd.decompress };
  })();
  return apkgLibs;
}
