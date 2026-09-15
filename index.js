process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import {
    makeWASocket, fetchLatestBaileysVersion, DisconnectReason,
    useMultiFileAuthState, makeCacheableSignalKeyStore, jidDecode, Browsers
} from "baileys";
import qrcode from "qrcode-terminal";
import Pino from "pino";
import chokidar from "chokidar";
import fs from "fs";
import { msgHandler as initialMsgHandler } from "./handler.js";
import { Messages } from "./lib/Messages.js";
import {
    saveToSheet, absenAll, addSiswa, hapusSiswa,
    readSheet, exportExcel,
    formatSheetRows, formatRekapSiswa,
    parseTanggal
} from "./lib/Sheets.js";

let msgHandler = initialMsgHandler;
const logger = Pino({ level: "silent" });
const PREFIX = ".";

// ═══════════════════════════════════════════════════════════
//  Utility
// ═══════════════════════════════════════════════════════════
async function react(sock, message, emoji) {
    try {
        await sock.sendMessage(message.key.remoteJid, {
            react: { text: emoji, key: message.key }
        });
    } catch {}
}

function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function splitArgs(text) {
    return text.split("|").map(s => s.trim()).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════
//  Registry command
//  Setiap handler: async (sock, message, arg, sender) => void
// ═══════════════════════════════════════════════════════════
const COMMANDS = {

    // ── .absen <no> | <status> | <DD/MM/YYYY> ──────────────
    async absen(sock, message, arg, sender) {
        const parts = splitArgs(arg);
        if (parts.length < 2) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, {
                text: `Format: .absen <no> | <status> | <DD/MM/YYYY>\nContoh: .absen 4 | H | 13/09/2026`
            }, { quoted: message });
            return;
        }
        const [no, status] = parts;
        const tanggal = parts[2] ? parseTanggal(parts[2]) : todayISO();
        if (!tanggal) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: "Tanggal harus DD/MM/YYYY" }, { quoted: message });
            return;
        }

        await react(sock, message, "⏳");
        try {
            const res = await saveToSheet({ nomor: sender, no, status, tanggal });
            if (res?.status === "success") await react(sock, message, "✅");
            else {
                await react(sock, message, "❌");
                await sock.sendMessage(sender, { text: res?.message || "Gagal" }, { quoted: message });
            }
        } catch (e) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: e.message }, { quoted: message });
        }
    },

    // ── .absenall <range> | <status> | <DD/MM/YYYY> ────────
    async absenall(sock, message, arg, sender) {
        const parts = splitArgs(arg);
        if (parts.length < 2) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, {
                text: `Format: .absenall <range> | <status> | <DD/MM/YYYY>\n` +
                      `Range: 1-33, 1,3,5, 1-10,15,20-25\n` +
                      `Contoh: .absenall 1-33 | H | 13/09/2026`
            }, { quoted: message });
            return;
        }
        const { parseRange } = await import("./lib/Sheets.js");
        const nos = parseRange(parts[0]);
        if (nos.length === 0) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: `Range kosong: ${parts[0]}` }, { quoted: message });
            return;
        }
        const status = parts[1];
        const tanggal = parts[2] ? parseTanggal(parts[2]) : todayISO();
        if (!tanggal) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: "Tanggal harus DD/MM/YYYY" }, { quoted: message });
            return;
        }

        await react(sock, message, "⏳");
        try {
            const res = await absenAll({ nos, status, tanggal });
            if (res?.status === "success") {
                await react(sock, message, "✅");
                let msg = `Absen massal: ${res.updated} siswa terisi ${res.statusCode}.`;
                if (res.skipped > 0) msg += `\n${res.skipped} dilewati: ${res.skippedNos.join(", ")}`;
                await sock.sendMessage(sender, { text: msg }, { quoted: message });
            } else {
                await react(sock, message, "❌");
                await sock.sendMessage(sender, { text: res?.message || "Gagal" }, { quoted: message });
            }
        } catch (e) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: e.message }, { quoted: message });
        }
    },

    // ── .add <nama> | <kelas> ──────────────────────────────
    async add(sock, message, arg, sender) {
        const parts = splitArgs(arg);
        if (parts.length < 2) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, {
                text: `Format: .add <nama> | <kelas>\nContoh: .add Budi Santoso | X-A`
            }, { quoted: message });
            return;
        }
        await react(sock, message, "⏳");
        try {
            const res = await addSiswa({ nama: parts[0], kelas: parts[1] });
            if (res?.status === "success") {
                await react(sock, message, "✅");
                await sock.sendMessage(sender, {
                    text: `Siswa ditambahkan.\nNo: ${res.no}\nNama: ${res.nama}\nKelas: ${res.kelas}`
                }, { quoted: message });
            } else {
                await react(sock, message, "❌");
                await sock.sendMessage(sender, { text: res?.message || "Gagal" }, { quoted: message });
            }
        } catch (e) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: e.message }, { quoted: message });
        }
    },

    // ── .hapus <no> ────────────────────────────────────────
    async hapus(sock, message, arg, sender) {
        const no = arg.trim();
        if (!/^\d+$/.test(no)) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: `Format: .hapus <no>` }, { quoted: message });
            return;
        }
        await react(sock, message, "⏳");
        try {
            const res = await hapusSiswa({ no: parseInt(no, 10) });
            if (res?.status === "success") {
                await react(sock, message, "✅");
                await sock.sendMessage(sender, {
                    text: `Siswa no ${res.no} (${res.nama}) dinonaktifkan.\nNomor tidak dipakai ulang.`
                }, { quoted: message });
            } else {
                await react(sock, message, "❌");
                await sock.sendMessage(sender, { text: res?.message || "Gagal" }, { quoted: message });
            }
        } catch (e) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: e.message }, { quoted: message });
        }
    },

    // ── .rekap <no> [file] ─────────────────────────────────
    async rekap(sock, message, arg, sender) {
        const parts = arg.trim().split(/\s+/);
        const no = parseInt(parts[0], 10);
        const asFile = parts.includes("file");

        if (isNaN(no)) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, {
                text: `Format: .rekap <no> [file]\nContoh:\n.rekap 4\n.rekap 4 file`
            }, { quoted: message });
            return;
        }

        await react(sock, message, "⏳");
        try {
            const data = await readSheet();
            if (data?.status !== "success") throw new Error(data?.message || "Gagal baca data");

            if (asFile) {
                const buf = await exportExcel({ no });
                const siswa = data.students.find(s => s.no === no);
                const fname = `Rekap_${siswa?.nama?.replace(/\s+/g, "_") || no}.xlsx`;
                await sock.sendMessage(sender, {
                    document: buf,
                    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    fileName: fname
                }, { quoted: message });
                await react(sock, message, "✅");
            } else {
                const teks = formatRekapSiswa(data, no);
                const isErr = teks.startsWith("❌");
                await react(sock, message, isErr ? "❌" : "✅");
                await sock.sendMessage(sender, { text: teks }, { quoted: message });
            }
        } catch (e) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: e.message }, { quoted: message });
        }
    },

    // ── .readsheet <DD/MM/YYYY> ────────────────────────────
    async readsheet(sock, message, arg, sender) {
        const tgl = arg.trim();
        if (!tgl) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, {
                text: `Format: .readsheet DD/MM/YYYY\nContoh: .readsheet 13/09/2026`
            }, { quoted: message });
            return;
        }
        if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(tgl)) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: `Format tanggal salah. Gunakan DD/MM/YYYY.` }, { quoted: message });
            return;
        }

        await react(sock, message, "⏳");
        try {
            const data = await readSheet();
            const teks = formatSheetRows(data, { limit: 30, tanggal: tgl });
            const isErr = teks.startsWith("⚠️") || teks.startsWith("❌");
            await react(sock, message, isErr ? "❌" : "✅");
            await sock.sendMessage(sender, { text: teks }, { quoted: message });
        } catch (e) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: e.message }, { quoted: message });
        }
    },

    // ── .export ────────────────────────────────────────────
    async export(sock, message, arg, sender) {
        await react(sock, message, "⏳");
        try {
            const buf = await exportExcel({});
            const tgl = new Date().toISOString().slice(0, 10);
            await sock.sendMessage(sender, {
                document: buf,
                mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                fileName: `Absensi_KIR_${tgl}.xlsx`
            }, { quoted: message });
            await react(sock, message, "✅");
        } catch (e) {
            await react(sock, message, "❌");
            await sock.sendMessage(sender, { text: e.message }, { quoted: message });
        }
    },

    // ── .menu ──────────────────────────────────────────────
    async menu(sock, message, arg, sender) {
        const menu =
`╭━━━〔 📋 *MENU BOT KIR* 〕━━━╮

*📌 ABSENSI*
┃ .absen <no> | <status> | <tgl>
┃   Absen satu siswa
┃   Contoh: .absen 4 | H | 13/09/2026
┃
┃ .absenall <range> | <status> | <tgl>
┃   Absen massal sekaligus
┃   Contoh: .absenall 1-33 | H | 13/09/2026
┃   Range: 1-33, 1,3,5, atau 1-10,15,20-25

*👥 MANAJEMEN SISWA*
┃ .add <nama> | <kelas>
┃   Tambah siswa baru
┃   Contoh: .add Budi Santoso | X-A
┃
┃ .hapus <no>
┃   Nonaktifkan siswa (riwayat tetap aman)
┃   Contoh: .hapus 34

*📊 LAPORAN*
┃ .rekap <no>
┃   Riwayat absensi satu siswa
┃   Contoh: .rekap 4
┃
┃ .rekap <no> file
┃   Download riwayat siswa (Excel)
┃   Contoh: .rekap 4 file
┃
┃ .readsheet <tgl>
┃   Rekap absensi harian
┃   Contoh: .readsheet 13/09/2026
┃
┃ .export
┃   Download semua data (Excel)

*ℹ️ LAINNYA*
┃ .menu — tampilkan menu ini

*📝 STATUS ABSENSI*
┃ H = Hadir
┃ S = Sakit
┃ I = Izin
┃ A = Alpa

╰━━━━━━━━━━━━━━━━━━━━━━━━╯`;
        await sock.sendMessage(sender, { text: menu }, { quoted: message });
    }
};

// Alias biar user bisa pakai beberapa nama
const ALIAS = {
    "menu": "menu", "help": "menu", "bantuan": "menu",
    "absen": "absen",
    "absenall": "absenall", "absenmassal": "absenall",
    "add": "add", "tambah": "add",
    "hapus": "hapus", "del": "hapus",
    "rekap": "rekap",
    "readsheet": "readsheet", "rekapabsen": "readsheet",
    "export": "export", "download": "export"
};

// ═══════════════════════════════════════════════════════════
//  Dispatcher
// ═══════════════════════════════════════════════════════════
async function handleCommands(sock, message) {
    const text = message.text?.trim() || "";
    if (!text.startsWith(PREFIX)) return false;

    // Parse: .cmd <arg>
    const withoutPrefix = text.slice(PREFIX.length).trim();
    const spaceIdx = withoutPrefix.search(/\s/);
    const rawCmd = (spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx)).toLowerCase();
    const arg = spaceIdx === -1 ? "" : withoutPrefix.slice(spaceIdx + 1);

    const handler = ALIAS[rawCmd];
    if (!handler || !COMMANDS[handler]) return false;

    await COMMANDS[handler](sock, message, arg, message.key.remoteJid);
    return true;
}

// ═══════════════════════════════════════════════════════════
//  Main bot
// ═══════════════════════════════════════════════════════════
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        retryRequestDelayMs: 300,
        maxMsgRetryCount: 10,
        version,
        logger,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        browser: Browsers.macOS("Chrome")
    });

    sock.ev.process(async (ev) => {
        if (ev["connection.update"]) {
            const { connection, lastDisconnect, qr } = ev["connection.update"];
            const status = lastDisconnect?.error?.output?.statusCode;

            if (qr) {
                qrcode.generate(qr, { small: true }, (q) => {
                    console.clear();
                    console.log("Scan QR:\n - index.js:384" + q);
                });
            }

            if (connection === "close") {
                const reason = Object.entries(DisconnectReason)
                    .find(([, v]) => v === status)?.[0] || "unknown";
                console.log(`Terputus  ${reason} (${status}) - index.js:391`);
                if (reason === "loggedOut" || reason === "multideviceMismatch" || status === 403) {
                    fs.rmSync("./session", { recursive: true, force: true });
                    console.log("Session dihapus. Jalankan ulang untuk scan QR. - index.js:394");
                } else if (reason !== "connectionReplaced") {
                    connectToWhatsApp();
                }
            } else if (connection === "open") {
                console.log(`Bot terhubung: ${jidDecode(sock?.user?.id)?.user} - index.js:399`);
            }
        }

        if (ev["creds.update"]) await saveCreds();

        const upsert = ev["messages.upsert"];
        if (upsert) {
            if (upsert.type !== "notify") return;
            const message = Messages(upsert, sock);
            if (!message) return;
            if (message.key?.remoteJid === "status@broadcast") return;
            if (
                message.key?.fromMe &&
                !["viewonce", "del", "math"].some(p =>
                    message.text?.toLowerCase().startsWith("." + p)
                )
            ) return;

            const handled = await handleCommands(sock, message);
            if (handled) return;

            msgHandler(upsert, sock, message);
        }

        if (ev["call"]) {
            const { id, chatId, isGroup } = ev["call"][0];
            if (isGroup) return;
            await sock.rejectCall(id, chatId);
        }
    });
}

connectToWhatsApp();

// ─── Hot-reload handler.js ─────────────────────────────────
const watcher = chokidar.watch("./handler.js", {
    ignored: /(^|[/\\])\../, persistent: true
});
watcher.on("change", async () => {
    try {
        const m = await import(`./handler.js?cacheBust=${Date.now()}`);
        msgHandler = m.msgHandler;
        console.log("Handler diperbarui. - index.js:442");
    } catch (e) { console.error("Reload gagal: - index.js:443", e.message); }
});