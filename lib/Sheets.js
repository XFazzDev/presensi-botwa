// ============================================================
//  lib/Sheets.js
//  Komunikasi dengan Google Apps Script Web App
//  - pakai fetch (bukan axios) → lebih tahan redirect 302
//  - retry otomatis 3x kalau timeout
//  - timeout 30 detik
// ============================================================

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbwzwY9edsa0gikxUAhPfTxct5abNxDmx0GXlL4HoK-VIsEZ3jOc0rSEeuQ-XTdUSCeK/exec";

const SHEET_SECRET = process.env.SHEET_SECRET || "gd";

if (!APPS_SCRIPT_URL) {
  console.warn("⚠️  APPS_SCRIPT_URL belum diset  fitur Spreadsheet nonaktif. - Sheets.js:15");
}

// ─── Helper: fetch dengan timeout ────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Helper: retry kalau timeout / koneksi putus ─────────────
async function retry(fn, { attempts = 3, delayMs = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isRetryable = /timeout|aborted|abort|ECONNRESET|socket hang up|network/i
        .test(String(err.message || ""));
      if (!isRetryable || i === attempts - 1) throw err;
      console.warn(`⚠️  Attempt ${i + 1} gagal (${err.message}), retry dalam ${delayMs}ms... - Sheets.js:40`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ─── Simpan absensi satu siswa ──────────────────────────────
export async function saveToSheet({ nomor, perintah, no, status, tanggal, extra = {} }) {
  if (!APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL kosong");

  const payload = {
    secret: SHEET_SECRET,
    nomor,
    perintah,   // "absen"
    no,
    status,
    tanggal,
    timestamp: new Date().toISOString(),
    ...extra
  };

  return await retry(async () => {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    }, 30000);

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: "error", message: "Non-JSON: " + text.slice(0, 200) };
    }
  });
}

// ─── Ambil seluruh data absensi ─────────────────────────────
export async function readSheet() {
  if (!APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL kosong");

  const url = `${APPS_SCRIPT_URL}?secret=${encodeURIComponent(SHEET_SECRET)}`;

  return await retry(async () => {
    const res = await fetchWithTimeout(url, { redirect: "follow" }, 30000);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: "error", message: "Non-JSON: " + text.slice(0, 200) };
    }
  });
}

// ─── Format data absensi jadi teks WhatsApp ─────────────────
export function formatSheetRows(data, { limit = 20, tanggal = null } = {}) {
  if (!data) return "📭 Belum ada data.";
  if (data.status === "error") return `⚠️ ${data.message || "unknown error"}`;

  const dates    = data.dates    || [];
  const students = data.students || [];

  if (dates.length === 0)    return "📭 Belum ada kolom tanggal di sheet.";
  if (students.length === 0) return "📭 Belum ada siswa di sheet.";

  const target = tanggal || dates[dates.length - 1];
  if (!dates.includes(target)) {
    return `⚠️ Tanggal ${target} tidak ada.\nTanggal tersedia: ${dates.join(", ")}`;
  }

  const counts = { H: 0, S: 0, I: 0, A: 0 };
  const details = [];

  students.forEach(s => {
    const code = String(s.attendance?.[target] || "").toUpperCase();
    if (code in counts) counts[code]++;
    if (["H", "S", "I", "A"].includes(code)) {
      details.push({ no: s.no, nama: s.nama, kelas: s.kelas, code });
    }
  });

  const lines = [
    `📊 *${data.title || "Absensi"}*`,
    `📅 Tanggal: ${target}`,
    ``,
    `✅ Hadir : ${counts.H}`,
    `🤒 Sakit : ${counts.S}`,
    `📝 Izin  : ${counts.I}`,
    `❌ Alpa  : ${counts.A}`,
    ``
  ];

  if (details.length > 0) {
    lines.push(`*Detail (${details.length} tercatat):*`);
    details.slice(0, limit).forEach(d => {
      const emoji = { H: "✅", S: "🤒", I: "📝", A: "❌" }[d.code] || "❓";
      lines.push(`${d.no}. ${d.nama} (${d.kelas}) — ${emoji}`);
    });
    if (details.length > limit) lines.push(`... dan ${details.length - limit} lainnya.`);
  } else {
    lines.push(`_Belum ada absensi untuk tanggal ini._`);
  }

  return lines.join("\n");
}