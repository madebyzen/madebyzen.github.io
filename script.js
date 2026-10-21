pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const { jsPDF } = window.jspdf;
const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

const IMG = /\.(jpe?g|png|bmp|gif|webp)$/i;
const PDF = /\.pdf$/i;

const PATTERNS = {
  img2pdf: "combined",
  pdf2img: "{name}_page_{n}",
  merge: "merged",
  split: "{name}_part_{n}",
  rotate: "{name}_rotated",
  stamp: "{name}_stamped",
  compress: "{name}_small",
  resize: "{name}_{w}x{h}",
};

const TIPS = {
  img2pdf: "Add images, set the order, and make one PDF.",
  pdf2img: "Turn every PDF page into a picture.",
  merge: "Join many PDF files into one. Text stays selectable.",
  split: "Cut a PDF into pages or ranges. Text stays selectable.",
  rotate: "Turn all pages, or only the pages you choose.",
  stamp: "Add a watermark and page numbers to a PDF.",
  compress: "Make files smaller. PDF pages become images.",
  resize: "Change the size of pictures.",
};

let tool = "img2pdf";
let files = [];
let outputs = [];
let used = new Set();
let uid = 1;
let deferredInstall = null;

const $ = (id) => document.getElementById(id);

/* ================= helpers ================= */

function sizeText(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + u[i];
}
const stem = (name) => name.replace(/\.[^.]+$/, "");

function safeName(text, fallback) {
  const c = (text || "").trim().replace(/[\\/:*?"<>|]/g, "_");
  return c || fallback;
}
function natural(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}
function toBlob(canvas, type, q) {
  return new Promise((r) => canvas.toBlob(r, type, q));
}
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3200);
}
function setStatus(t) { $("status").textContent = t; }
function setBar(d, t) { $("barFill").style.width = (t ? (100 * d) / t : 0) + "%"; }

function fmtName(pattern, v) {
  const s = pattern
    .replace(/\{name\}/g, v.name)
    .replace(/\{n\}/g, String(v.n).padStart(3, "0"))
    .replace(/\{w\}/g, v.w ?? "")
    .replace(/\{h\}/g, v.h ?? "");
  return safeName(s, v.name);
}

// Save one output. A repeated name gets _1, _2 and so on.
function add(base, ext, blob, group) {
  let name = base, i = 1;
  const key = () => (group ? group + "/" : "") + name + ext;
  while (used.has(key())) { name = base + "_" + i; i++; }
  used.add(key());
  outputs.push({ id: uid++, name, ext, blob, group });
}

function pdfBlob(bytes) {
  return new Blob([bytes], { type: "application/pdf" });
}

// Read a page text like "1-3, 5, 7-9". Returns a list of groups of page numbers (0-based).
function parseRanges(text, total) {
  const groups = [];
  for (const part of text.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`"${p}" is not a valid page range.`);
    let a = Number(m[1]);
    let b = m[2] ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > total) throw new Error(`Page range ${p} is outside 1-${total}.`);
    const g = [];
    for (let i = a; i <= b; i++) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) throw new Error("Please enter the pages.");
  return groups;
}

/* ================= canvas and pdf.js ================= */

function whiteCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  return c;
}

async function imageToCanvas(file, w, h, transparent) {
  const bmp = await createImageBitmap(file);
  const width = w || bmp.width, height = h || bmp.height;
  let c;
  if (transparent) {
    c = document.createElement("canvas");
    c.width = width; c.height = height;
    c.getContext("2d").imageSmoothingQuality = "high";
  } else {
    c = whiteCanvas(width, height);
  }
  c.getContext("2d").drawImage(bmp, 0, 0, width, height);
  bmp.close();
  return c;
}

async function imageSize(file) {
  const bmp = await createImageBitmap(file);
  const s = { w: bmp.width, h: bmp.height };
  bmp.close();
  return s;
}

async function renderPdf(file, scale, onPage) {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale });
    const canvas = whiteCanvas(Math.floor(vp.width), Math.floor(vp.height));
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    await onPage(canvas, i);
  }
}

function pageSpec(canvas, mode) {
  if (mode === "a4") {
    const land = canvas.width > canvas.height;
    const pw = land ? 841.89 : 595.28, ph = land ? 595.28 : 841.89, m = 20;
    const k = Math.min((pw - 2 * m) / canvas.width, (ph - 2 * m) / canvas.height);
    const w = canvas.width * k, h = canvas.height * k;
    return { pw, ph, x: (pw - w) / 2, y: (ph - h) / 2, w, h };
  }
  const pw = canvas.width * 0.75, ph = canvas.height * 0.75;
  return { pw, ph, x: 0, y: 0, w: pw, h: ph };
}

function addPdfPage(doc, canvas, mode, quality) {
  const s = pageSpec(canvas, mode);
  let d = doc;
  if (!d) {
    d = new jsPDF({ unit: "pt", format: [s.pw, s.ph], orientation: s.pw > s.ph ? "l" : "p" });
  } else {
    d.addPage([s.pw, s.ph], s.pw > s.ph ? "l" : "p");
  }
  d.addImage(canvas.toDataURL("image/jpeg", quality), "JPEG", s.x, s.y, s.w, s.h);
  return d;
}

async function loadPdfLib(file) {
  const bytes = await file.arrayBuffer();
  return PDFDocument.load(bytes, { ignoreEncryption: true });
}

/* ================= jobs ================= */

async function jobImg2Pdf(items, ctx) {
  const mode = $("pageSize").value;
  const pattern = $("pattern").value;
  if ($("separate").checked) {
    for (const it of items) {
      const canvas = await imageToCanvas(it.file);
      const doc = addPdfPage(null, canvas, mode, 0.92);
      let base = fmtName(pattern, { name: stem(it.file.name), n: it.index });
      if (!/\{(name|n)\}/.test(pattern)) base += "_" + stem(it.file.name);
      ctx.add(base, ".pdf", doc.output("blob"));
      ctx.step(it.file.name);
    }
    return;
  }
  let doc = null;
  for (const it of items) {
    const canvas = await imageToCanvas(it.file);
    doc = addPdfPage(doc, canvas, mode, 0.92);
    ctx.step(it.file.name);
  }
  ctx.add(fmtName(pattern, { name: "combined", n: 1 }), ".pdf", doc.output("blob"));
}

async function jobPdf2Img(items, ctx) {
  const dpi = Number($("p2iDpi").value) || 150;
  const fmt = $("p2iFmt").value;
  const type = fmt === "png" ? "image/png" : "image/jpeg";
  const pattern = $("pattern").value;
  for (const it of items) {
    const s = stem(it.file.name);
    await renderPdf(it.file, dpi / 72, async (canvas, n) => {
      const blob = await toBlob(canvas, type, 0.92);
      const base = fmtName(pattern, { name: s, n, w: canvas.width, h: canvas.height });
      ctx.add(base, "." + fmt, blob, s);
    });
    ctx.step(it.file.name);
  }
}

async function jobMerge(items, ctx) {
  const out = await PDFDocument.create();
  for (const it of items) {
    try {
      const src = await loadPdfLib(it.file);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } catch (e) {
      ctx.fail(`${it.file.name}: ${e.message}`);
    }
    ctx.step(it.file.name);
  }
  if (out.getPageCount() === 0) throw new Error("No pages to merge.");
  const bytes = await out.save();
  ctx.add(fmtName($("pattern").value, { name: "merged", n: 1 }), ".pdf", pdfBlob(bytes));
}

async function jobSplit(items, ctx) {
  const mode = $("splitMode").value;
  const pattern = $("pattern").value;
  for (const it of items) {
    const s = stem(it.file.name);
    const src = await loadPdfLib(it.file);
    const total = src.getPageCount();
    let groups;
    if (mode === "each") {
      groups = src.getPageIndices().map((i) => [i]);
    } else if (mode === "ranges") {
      groups = parseRanges($("splitRange").value, total);
    } else {
      groups = [parseRanges($("splitRange").value, total).flat()];
    }
    for (let k = 0; k < groups.length; k++) {
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, groups[k]);
      pages.forEach((p) => out.addPage(p));
      const bytes = await out.save();
      const base = fmtName(pattern, { name: s, n: k + 1 });
      ctx.add(base, ".pdf", pdfBlob(bytes), groups.length > 1 ? s : undefined);
    }
    ctx.step(it.file.name);
  }
}

async function jobRotate(items, ctx) {
  const angle = Number($("rotAngle").value) || 90;
  const text = $("rotRange").value.trim();
  const pattern = $("pattern").value;
  for (const it of items) {
    const doc = await loadPdfLib(it.file);
    const total = doc.getPageCount();
    const list = text ? parseRanges(text, total).flat() : doc.getPageIndices();
    const set = new Set(list);
    doc.getPages().forEach((page, i) => {
      if (set.has(i)) {
        const now = page.getRotation().angle || 0;
        page.setRotation(degrees((now + angle) % 360));
      }
    });
    const bytes = await doc.save();
    ctx.add(fmtName(pattern, { name: stem(it.file.name), n: it.index }), ".pdf", pdfBlob(bytes));
    ctx.step(it.file.name);
  }
}

async function jobStamp(items, ctx) {
  const text = $("wmText").value.trim();
  const size = Number($("wmSize").value) || 60;
  const opacity = (Number($("wmOpacity").value) || 25) / 100;
  const numbers = $("pageNums").checked;
  const pattern = $("pattern").value;
  if (!text && !numbers) throw new Error("Type a watermark or turn on page numbers.");

  for (const it of items) {
    const doc = await loadPdfLib(it.file);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const small = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();

    pages.forEach((page, i) => {
      const { width, height } = page.getSize();
      if (text) {
        const tw = font.widthOfTextAtSize(text, size);
        const a = Math.PI / 4;
        const x = width / 2 - (tw / 2) * Math.cos(a) + size * 0.3 * Math.sin(a);
        const y = height / 2 - (tw / 2) * Math.sin(a) - size * 0.3 * Math.cos(a);
        page.drawText(text, {
          x, y, size, font,
          color: rgb(0.5, 0.5, 0.5),
          opacity,
          rotate: degrees(45),
        });
      }
      if (numbers) {
        const label = `${i + 1} / ${pages.length}`;
        const lw = small.widthOfTextAtSize(label, 10);
        page.drawText(label, { x: width / 2 - lw / 2, y: 18, size: 10, font: small, color: rgb(0.3, 0.3, 0.3) });
      }
    });

    const bytes = await doc.save();
    ctx.add(fmtName(pattern, { name: stem(it.file.name), n: it.index }), ".pdf", pdfBlob(bytes));
    ctx.step(it.file.name);
  }
}

async function jobCompress(items, ctx) {
  const q = (Number($("cQuality").value) || 70) / 100;
  const maxSide = Number($("cMax").value) || 0;
  const dpi = Number($("cDpi").value) || 100;
  const pattern = $("pattern").value;

  for (const it of items) {
    const s = stem(it.file.name);
    if (PDF.test(it.file.name)) {
      let doc = null;
      await renderPdf(it.file, dpi / 72, async (canvas) => {
        doc = addPdfPage(doc, canvas, "fit", q);
      });
      ctx.add(fmtName(pattern, { name: s, n: it.index }), ".pdf", doc.output("blob"));
    } else {
      let { w, h } = await imageSize(it.file);
      if (maxSide && Math.max(w, h) > maxSide) {
        const k = maxSide / Math.max(w, h);
        w = Math.round(w * k); h = Math.round(h * k);
      }
      const canvas = await imageToCanvas(it.file, w, h);
      const blob = await toBlob(canvas, "image/jpeg", q);
      ctx.add(fmtName(pattern, { name: s, n: it.index, w, h }), ".jpg", blob);
    }
    ctx.step(it.file.name);
  }
}

async function jobResize(items, ctx) {
  const width = Number($("rWidth").value) || 0;
  const height = Number($("rHeight").value) || 0;
  const scale = Number($("rScale").value) || 0;
  const pick = $("rFmt").value;
  const pattern = $("pattern").value;
  if (!width && !height && !scale) throw new Error("Enter a width, a height or a scale.");

  for (const it of items) {
    const { w, h } = await imageSize(it.file);
    let nw, nh;
    if (scale) { nw = w * scale; nh = h * scale; }
    else if (width && height) { nw = width; nh = height; }
    else if (width) { nw = width; nh = (h * width) / w; }
    else { nh = height; nw = (w * height) / h; }
    nw = Math.max(1, Math.round(nw));
    nh = Math.max(1, Math.round(nh));

    let fmt = pick;
    if (fmt === "keep") {
      fmt = /\.png$/i.test(it.file.name) ? "png" : /\.webp$/i.test(it.file.name) ? "webp" : "jpg";
    }
    const type = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[fmt];
    const canvas = await imageToCanvas(it.file, nw, nh, fmt !== "jpg");
    const blob = await toBlob(canvas, type, 0.92);
    ctx.add(fmtName(pattern, { name: stem(it.file.name), n: it.index, w: nw, h: nh }), "." + fmt, blob);
    ctx.step(it.file.name);
  }
}

const JOBS = {
  img2pdf: jobImg2Pdf,
  pdf2img: jobPdf2Img,
  merge: jobMerge,
  split: jobSplit,
  rotate: jobRotate,
  stamp: jobStamp,
  compress: jobCompress,
  resize: jobResize,
};

/* ================= run ================= */

function usable(f) {
  if (tool === "img2pdf" || tool === "resize") return IMG.test(f.name);
  if (tool === "compress") return IMG.test(f.name) || PDF.test(f.name);
  return PDF.test(f.name); // pdf2img, merge, split, rotate, stamp
}

function isBatch() {
  return tool === "merge" || (tool === "img2pdf" && !$("separate").checked);
}

async function run() {
  const items = files
    .map((f, i) => ({ file: f.file, index: i + 1 }))
    .filter((it) => usable(it.file));

  if (!items.length) {
    setStatus("No matching files. Please add the right type of file for this tool.");
    return;
  }

  outputs = [];
  used = new Set();
  uid = 1;
  $("results").classList.add("hidden");
  $("runBtn").disabled = true;
  setBar(0, items.length);

  const job = JOBS[tool];
  const errors = [];
  let done = 0;
  const ctx = {
    add,
    fail: (m) => errors.push(m),
    step: (name) => {
      done++;
      setBar(done, items.length);
      setStatus(`Working: ${name} (${done}/${items.length})`);
    },
  };

  try {
    if (isBatch()) {
      await job(items, ctx);
    } else {
      for (const it of items) {
        try {
          await job([it], ctx);
        } catch (e) {
          errors.push(`${it.file.name}: ${e.message}`);
          done++;
          setBar(done, items.length);
        }
      }
    }
  } catch (e) {
    errors.push(e.message);
  }

  $("runBtn").disabled = false;
  showResults(items, errors);
}

/* ================= results, rename and share ================= */

function showResults(items, errors) {
  const list = $("list");
  list.innerHTML = "";

  outputs.forEach((o) => {
    const row = document.createElement("div");
    row.className = "item";

    const rn = document.createElement("div");
    rn.className = "rn";
    const input = document.createElement("input");
    input.type = "text";
    input.value = o.name;
    input.addEventListener("input", () => { o.name = safeName(input.value, "file"); });
    const ext = document.createElement("span");
    ext.className = "ext";
    ext.textContent = o.ext;
    rn.append(input, ext);

    const sz = document.createElement("span");
    sz.className = "sz";
    sz.textContent = sizeText(o.blob.size);

    const acts = document.createElement("div");
    acts.className = "acts";
    const dl = document.createElement("button");
    dl.type = "button";
    dl.textContent = "Download";
    dl.onclick = () => downloadOne(o);
    const sh = document.createElement("button");
    sh.type = "button";
    sh.textContent = "Share";
    sh.onclick = () => shareFiles([o], "more");
    acts.append(dl, sh);

    row.append(rn, sz, acts);
    list.appendChild(row);
  });

  errors.forEach((m) => {
    const row = document.createElement("div");
    row.className = "item err";
    row.textContent = "Error: " + m;
    list.appendChild(row);
  });

  let text = `Finished. ${outputs.length} file(s) created, ${errors.length} error(s).`;
  if (tool === "compress" && outputs.length) {
    const before = items.reduce((s, it) => s + it.file.size, 0);
    const after = outputs.reduce((s, o) => s + o.blob.size, 0);
    text += ` Size ${sizeText(before)} to ${sizeText(after)} (${(100 * (1 - after / before)).toFixed(1)}% saved).`;
  }
  setStatus(text);

  $("results").classList.toggle("hidden", !outputs.length && !errors.length);
  $("zipBtn").classList.toggle("hidden", !outputs.length);
  $("shareRow").classList.toggle("hidden", !outputs.length);
  if (outputs.length || errors.length) $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
const downloadOne = (o) => downloadBlob(o.blob, o.name + o.ext);

async function makeZip() {
  const zip = new JSZip();
  const folder = safeName($("folderName").value, "output");
  const seen = new Set();
  for (const o of outputs) {
    let base = o.name, i = 1;
    const path = () => `${folder}/${o.group ? o.group + "/" : ""}${base}${o.ext}`;
    while (seen.has(path())) { base = o.name + "_" + i; i++; }
    seen.add(path());
    zip.file(path(), o.blob);
  }
  return { blob: await zip.generateAsync({ type: "blob" }), name: folder + ".zip" };
}

async function downloadZip() {
  const z = await makeZip();
  downloadBlob(z.blob, z.name);
}

async function shareFiles(list, app) {
  const fileObjs = list.map((o) => new File([o.blob], o.name + o.ext, { type: o.blob.type }));
  if (navigator.canShare && navigator.canShare({ files: fileObjs })) {
    try {
      await navigator.share({ files: fileObjs, title: "Made with SnapPDF" });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  // Fallback for PC and browsers that cannot share files.
  list.forEach(downloadOne);
  const msg = encodeURIComponent("I made this file with SnapPDF.");
  if (app === "whatsapp") {
    window.open("https://wa.me/?text=" + msg, "_blank");
    toast("File saved. Attach it in WhatsApp.");
  } else if (app === "telegram") {
    window.open("https://t.me/share/url?url=" + encodeURIComponent(location.href) + "&text=" + msg, "_blank");
    toast("File saved. Attach it in Telegram.");
  } else if (app === "bluetooth") {
    toast("File saved. Send it by Bluetooth from your device.");
  } else {
    toast("File saved. Sharing is not supported in this browser.");
  }
}

async function shareZip() {
  const z = await makeZip();
  const f = new File([z.blob], z.name, { type: "application/zip" });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: "Made with SnapPDF" }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  downloadBlob(z.blob, z.name);
  toast("ZIP saved. Sharing is not supported here.");
}

/* ================= file list ================= */

function renderFiles() {
  const box = $("files");
  box.innerHTML = "";

  files.forEach((f, i) => {
    const ok = usable(f.file);
    const row = document.createElement("div");
    row.className = "file" + (ok ? "" : " skip");

    let thumb;
    if (IMG.test(f.file.name)) {
      thumb = document.createElement("img");
      thumb.src = f.url;
      thumb.alt = "";
    } else {
      thumb = document.createElement("div");
      thumb.textContent = PDF.test(f.file.name) ? "PDF" : "FILE";
    }
    thumb.className = "thumb";

    const info = document.createElement("div");
    info.className = "finfo";
    const nm = document.createElement("div");
    nm.className = "fname";
    nm.textContent = f.file.name;
    const sz = document.createElement("div");
    sz.className = "fsize";
    sz.textContent = sizeText(f.file.size) + (ok ? "" : " - not used by this tool");
    info.append(nm, sz);

    const mini = document.createElement("div");
    mini.className = "mini";
    [["↑", () => move(i, -1)], ["↓", () => move(i, 1)], ["✕", () => remove(i)]].forEach(([label, fn]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.onclick = fn;
      mini.appendChild(b);
    });

    row.append(thumb, info, mini);
    box.appendChild(row);
  });

  const n = files.filter((f) => usable(f.file)).length;
  $("listHead").classList.toggle("hidden", !files.length);
  const total = files.reduce((s, f) => s + f.file.size, 0);
  $("count").textContent = `${files.length} file(s), ${n} usable, ${sizeText(total)}`;
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= files.length) return;
  [files[i], files[j]] = [files[j], files[i]];
  renderFiles();
}
function remove(i) {
  if (files[i].url) URL.revokeObjectURL(files[i].url);
  files.splice(i, 1);
  renderFiles();
}
function addFiles(list) {
  const fresh = Array.from(list).sort(natural);
  fresh.forEach((file) =>
    files.push({ file, url: IMG.test(file.name) ? URL.createObjectURL(file) : "" })
  );
  renderFiles();
}

/* ================= events ================= */

function showTool(name) {
  tool = name;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
  document.querySelectorAll(".opts[data-tool]").forEach((s) => s.classList.toggle("hidden", s.dataset.tool !== name));
  $("pattern").value = PATTERNS[name];
  $("tip").textContent = TIPS[name];
  renderFiles();
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    showTool(btn.dataset.tool);
    btn.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  });
});

$("fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
$("folderInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
$("clearBtn").addEventListener("click", () => {
  files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
  files = [];
  renderFiles();
});
$("runBtn").addEventListener("click", run);
$("zipBtn").addEventListener("click", downloadZip);
$("cQuality").addEventListener("input", (e) => { $("qVal").textContent = e.target.value; });
$("wmOpacity").addEventListener("input", (e) => { $("wmOpVal").textContent = e.target.value; });
$("splitMode").addEventListener("change", (e) => {
  $("rangeBox").classList.toggle("hidden", e.target.value === "each");
});

document.querySelectorAll(".share").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.app === "zip") shareZip();
    else shareFiles(outputs, b.dataset.app);
  });
});

const drop = $("drop");
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); })
);
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

// Paste files with Ctrl+V.
window.addEventListener("paste", (e) => {
  const list = Array.from((e.clipboardData && e.clipboardData.files) || []);
  if (list.length) addFiles(list);
});

// Theme.
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch (e) {}
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem("theme"); } catch (e) {}
  if (!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(t);
})();
$("themeBtn").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

// Install button.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  $("installBtn").classList.remove("hidden");
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $("installBtn").classList.add("hidden");
});

// Start.
$("rangeBox").classList.add("hidden");
showTool("img2pdf");