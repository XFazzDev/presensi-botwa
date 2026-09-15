// ============================================================
//  lib/Sheets.js — HTTP client + parser + Excel exporter
// ============================================================
import ExcelJS from "exceljs";

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbwzwY9edsa0gikxUAhPfTxct5abNxDmx0GXlL4HoK-VIsEZ3jOc0rSEeuQ-XTdUSCeK/exec";
const SHEET_SECRET = process.env.SHEET_SECRET || "gd";

// ─── HTTP core ──────────────────────────────────────────────
async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function isLoginPage(text) {
  return /accounts\.google\.com|ServiceLogin|ppConfig|<!DOCTYPE html>/i.test(text.slice(0, 300));
}

async function smartFetch(url, options = {}) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchWithTimeout(url, { ...options, redirect: "follow" }, 30000);
      const text = await res.text();
      if (isLoginPage(text)) {
        if (i < 2) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
        return { status: "error", message: "Apps Script rate limit. Coba lagi nanti." };
      }
      try { return JSON.parse(text); }
      catch { return { status: "error", message: "Non-JSON: " + text.slice(0, 150) }; }
    } catch (err) {
      lastErr = err;
      if (i < 2) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
    }
  }
  throw lastErr || new Error("Gagal fetch");
}

async function post(payload) {
  return smartFetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: SHEET_SECRET, ...payload })
  });
}

// ─── Public API ─────────────────────────────────────────────
export const saveToSheet = ({ nomor, no, status, tanggal }) =>
  post({ perintah: "absen", nomor, no, status, tanggal });

export const absenAll = ({ nos, status, tanggal }) =>
  post({ perintah: "absenall", nos, status, tanggal });

export const addSiswa = ({ nama, kelas }) =>
  post({ perintah: "add", nama, kelas });

export const hapusSiswa = ({ no }) =>
  post({ perintah: "hapus", no });

export const readSheet = () =>
  smartFetch(`${APPS_SCRIPT_URL}?secret=${encodeURIComponent(SHEET_SECRET)}`, {});

// ─── Parser helpers ─────────────────────────────────────────
export function parseTanggal(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return null;
}

export function formatTglIndo(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function parseRange(str) {
  const set = new Set();
  String(str).split(",").forEach(part => {
    part = part.trim();
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(s => parseInt(s.trim(), 10));
      if (!isNaN(a) && !isNaN(b) && a <= b && (b - a) < 500) {
        for (let i = a; i <= b; i++) set.add(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n)) set.add(n);
    }
  });
  return [...set].sort((a, b) => a - b);
}

// ─── Formatter rekap harian ─────────────────────────────────
export function formatSheetRows(data, { limit = 30, tanggal = null } = {}) {
  if (!tanggal) return `⚠️ Tanggal wajib diisi!\n\nFormat:\n.readsheet DD/MM/YYYY`;
  const key = parseTanggal(tanggal);
  if (!key) return `⚠️ Format tanggal salah: ${tanggal}\nGunakan DD/MM/YYYY.`;
  if (!data) return "❌ Tidak ada respons.";
  if (data.status === "error") return `❌ ${data.message}`;

  const dates = data.dates || [];
  const students = data.students || [];
  if (students.length === 0) return "❌ Belum ada siswa.";

  if (!dates.includes(key)) {
    const daftar = dates.length > 0
      ? dates.map(d => `- ${formatTglIndo(d)}`).join("\n")
      : "- (belum ada tanggal)";
    return `❌ Tanggal ${tanggal} belum ada.\n\nTanggal tersedia:\n${daftar}`;
  }

  const c = { H: 0, S: 0, I: 0, A: 0 };
  const details = [];
  for (const s of students) {
    const code = String(s.attendance?.[key] || "").trim().toUpperCase();
    if (code in c) c[code]++;
    if (["H", "S", "I", "A"].includes(code)) {
      details.push(`${code}  ${s.no}. ${s.nama} (${s.kelas})`);
    }
  }

  const lines = [
    `📊 *${data.title || "Absensi"}*`,
    `📅 ${tanggal}`,
    ``,
    `✅ H (Hadir) : ${c.H}`,
    `🤒 S (Sakit) : ${c.S}`,
    `📝 I (Izin)  : ${c.I}`,
    `❌ A (Alpa)  : ${c.A}`,
    `➖ Belum     : ${students.length - details.length}`,
    `👥 Total     : ${students.length}`
  ];
  if (details.length > 0) {
    lines.push(``, `*Detail:*`);
    details.slice(0, limit).forEach(d => lines.push(d));
    if (details.length > limit) lines.push(`... +${details.length - limit} lainnya`);
  }
  return lines.join("\n");
}

// ─── Formatter rekap per siswa ──────────────────────────────
export function formatRekapSiswa(data, no) {
  if (!data || data.status === "error") return `❌ ${data?.message || "Tidak ada data"}`;

  const s = (data.students || []).find(x => x.no === no);
  if (!s) return `❌ Siswa no ${no} tidak ditemukan.`;

  const dates = data.dates || [];
  const entries = [];
  const c = { H: 0, S: 0, I: 0, A: 0 };

  for (const d of dates) {
    const code = String(s.attendance?.[d] || "").trim().toUpperCase();
    if (["H", "S", "I", "A"].includes(code)) {
      c[code]++;
      entries.push(`${formatTglIndo(d)} : ${code}`);
    }
  }

  const total = entries.length;
  const persen = total > 0 ? ((c.H / total) * 100).toFixed(1) : "0.0";

  const lines = [
    `📋 *Rekap: ${s.nama}*`,
    `🏫 Kelas: ${s.kelas}`,
    `🔢 No: ${s.no}`,
    ``,
    `📅 Total absensi : ${total}`,
    `✅ H : ${c.H}`,
    `🤒 S : ${c.S}`,
    `📝 I : ${c.I}`,
    `❌ A : ${c.A}`,
    `📊 Persentase hadir: ${persen}%`
  ];

  if (entries.length > 0) {
    lines.push(``, `*Riwayat:*`);
    entries.slice(-20).forEach(e => lines.push(e));
    if (entries.length > 20) lines.push(`... +${entries.length - 20} lainnya`);
  }
  return lines.join("\n");
}

// ─── Excel export ───────────────────────────────────────────
export async function exportExcel({ no = null } = {}) {
  const data = await readSheet();
  if (!data || data.status !== "success") throw new Error(data?.message || "Gagal baca data");

  const wb = new ExcelJS.Workbook();
  wb.creator = "Bot Absensi KIR";
  wb.created = new Date();

  const dates = data.dates || [];
  const students = no ? data.students.filter(s => s.no === no) : data.students;
  if (students.length === 0) throw new Error("Tidak ada data");

  // Sheet 1: Detail
  const ws = wb.addWorksheet("Detail");
  ws.columns = [
    { header: "No",    key: "no",    width: 6 },
    { header: "Nama",  key: "nama",  width: 32 },
    { header: "Kelas", key: "kelas", width: 10 },
    ...dates.map(d => ({ header: formatTglIndo(d), key: d, width: 12 }))
  ];
  students.forEach(s => {
    const row = { no: s.no, nama: s.nama, kelas: s.kelas };
    dates.forEach(d => { row[d] = s.attendance[d] || ""; });
    ws.addRow(row);
  });
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
  ws.getRow(1).alignment = { horizontal: "center" };

  // Sheet 2: Ringkasan
  const ws2 = wb.addWorksheet("Ringkasan");
  ws2.columns = [
    { header: "No",     key: "no",    width: 6 },
    { header: "Nama",   key: "nama",  width: 32 },
    { header: "Kelas",  key: "kelas", width: 10 },
    { header: "H",      key: "h",     width: 6 },
    { header: "S",      key: "s",     width: 6 },
    { header: "I",      key: "i",     width: 6 },
    { header: "A",      key: "a",     width: 6 },
    { header: "Total",  key: "t",     width: 8 },
    { header: "%Hadir", key: "p",     width: 10 }
  ];
  students.forEach(s => {
    const cc = { H: 0, S: 0, I: 0, A: 0 };
    dates.forEach(d => {
      const code = String(s.attendance[d] || "").toUpperCase();
      if (code in cc) cc[code]++;
    });
    const t = cc.H + cc.S + cc.I + cc.A;
    const pct = t > 0 ? ((cc.H / t) * 100).toFixed(1) + "%" : "0%";
    ws2.addRow({ no: s.no, nama: s.nama, kelas: s.kelas, h: cc.H, s: cc.S, i: cc.I, a: cc.A, t, p: pct });
  });
  ws2.getRow(1).font = { bold: true };
  ws2.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}