process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import {
    makeWASocket,
    fetchLatestBaileysVersion,
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
    jidDecode,
    Browsers
} from "baileys";
import qrcode from "qrcode-terminal";
import Pino from "pino";
import chokidar from "chokidar";
import fs from "fs";
import { msgHandler as initialMsgHandler } from "./handler.js";
import { Messages } from "./lib/Messages.js";
import { saveToSheet, readSheet, formatSheetRows } from "./lib/Sheets.js";

let msgHandler = initialMsgHandler;
const logger = Pino({ level: "silent" });

// ─── Konstanta command ──────────────────────────────────────
const SHEET_PREFIX = ".";
const CMD_ABSEN    = "absen";     // .absen <no> | <status> | [tanggal]
const CMD_READ     = "readsheet"; // .readsheet [tanggal]

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL ||
    "https://script.google.com/macros/s/AKfycbwzwY9edsa0gikxUAhPfTxct5abNxDmx0GXlL4HoK-VIsEZ3jOc0rSEeuQ-XTdUSCeK/exec";

const SHEET_SECRET = process.env.SHEET_SECRET || "gd";

/**
 * Format tanggal default (hari ini) dalam format YYYY-MM-DD.
 */
function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${dd}`;
}

/**
 * Handler command absensi & baca spreadsheet.
 */
async function handleSheetCommands(sock, message) {
    const text = message.text?.trim() || "";
    if (!text.startsWith(SHEET_PREFIX)) return false;

    const lower  = text.toLowerCase();
    const sender = message.key.remoteJid;

    // ── .absen <no> | <status> | [tanggal] ────────────────────
    if (lower.startsWith(`${SHEET_PREFIX}${CMD_ABSEN}`)) {
        const isi   = text.slice((SHEET_PREFIX + CMD_ABSEN).length).trim();
        const parts = isi.split("|").map(s => s.trim());

        if (parts.length < 2 || parts.some(p => !p)) {
            await sock.sendMessage(sender, {
                text:
                    `⚠️ Format salah.\n\n` +
                    `*Format:*\n\`${SHEET_PREFIX}${CMD_ABSEN} <no> | <status> | <tanggal>\`\n\n` +
                    `*Status:* \`h\` hadir, \`s\` sakit, \`i\` izin, \`a\` alpa\n` +
                    `*Tanggal:* opsional, default hari ini. Format \`YYYY-MM-DD\` atau \`DD/MM/YYYY\`\n\n` +
                    `*Contoh:*\n` +
                    `\`${SHEET_PREFIX}${CMD_ABSEN} 4 | hadir | 2026-09-12\`\n` +
                    `\`${SHEET_PREFIX}${CMD_ABSEN} 4 | s\``
            });
            return true;
        }

        const no      = parts[0];
        const status  = parts[1];
        const tanggal = parts[2] || todayISO();

        if (isNaN(parseInt(no, 10))) {
            await sock.sendMessage(sender, { text: `⚠️ Nomor absen "${no}" tidak valid.` });
            return true;
        }

        try {
            await sock.sendMessage(sender, { text: "⏳ Menyimpan absensi..." });

            const res = await saveToSheet({
                nomor: sender,
                perintah: CMD_ABSEN,
                no,
                status,
                tanggal,
                extra: {
                    pushName: message.pushName || "-",
                    isGroup: sender?.endsWith("@g.us") || false
                }
            });

            if (res?.status === "success") {
                const emoji = { H: "✅", S: "🤒", I: "📝", A: "❌" }[res.statusCode] || "📝";
                await sock.sendMessage(sender, {
                    text:
                        `${emoji} *Absensi tercatat!*\n\n` +
                        `🔢 No: ${res.no}\n` +
                        `👤 Nama: ${res.nama}\n` +
                        `🏫 Kelas: ${res.kelas}\n` +
                        `📅 Tanggal: ${res.tanggal}\n` +
                        `📌 Status: ${res.statusLabel} (${res.statusCode})`
                });
            } else {
                await sock.sendMessage(sender, {
                    text: `❌ Gagal: ${res?.message || "unknown"}`
                });
            }
        } catch (err) {
            console.error("❌ saveToSheet error: - index.js:114", err.message);
            await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
        }
        return true;
    }

    // ── .readsheet [tanggal] ─────────────────────────────────
    if (lower.startsWith(`${SHEET_PREFIX}${CMD_READ}`)) {
        const arg = text.slice((SHEET_PREFIX + CMD_READ).length).trim();
        try {
            await sock.sendMessage(sender, { text: "⏳ Mengambil data..." });

            const data = await readSheet();
            const teks = formatSheetRows(data, { limit: 20, tanggal: arg || null });

            await sock.sendMessage(sender, { text: teks });
        } catch (err) {
            console.error("❌ readSheet error: - index.js:131", err.message);
            await sock.sendMessage(sender, { text: `❌ Error: ${err.message}` });
        }
        return true;
    }

    return false;
}

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
        generateHighQualityLinkPreview: true,
        browser: Browsers.macOS("Chrome")
    });

    sock.ev.process(async (ev) => {
        // ─── Connection Update ─────────────────────────────────
        if (ev["connection.update"]) {
            const update = ev["connection.update"];
            const { connection, lastDisconnect } = update;
            const status = lastDisconnect?.error?.output?.statusCode;

            if (update.qr) {
                qrcode.generate(update.qr, { small: true }, (qr) => {
                    console.clear();
                    console.log("📱 Scan QR Code ini dengan WhatsApp:\n - index.js:168");
                    console.log(qr);
                });
            }

            if (connection === "close") {
                const reason =
                    Object.entries(DisconnectReason).find(([, v]) => v === status)?.[0] ||
                    "unknown";
                console.log(`⚡ Koneksi terputus  ${reason} (${status}) - index.js:177`);

                switch (reason) {
                    case "multideviceMismatch":
                    case "loggedOut":
                        console.error(lastDisconnect.error);
                        fs.rmSync("./session", { recursive: true, force: true });
                        console.log("🔄 Session dihapus. Jalankan ulang bot untuk scan QR baru. - index.js:184");
                        break;
                    case "connectionReplaced":
                        console.log("⚠️ Koneksi digantikan oleh sesi lain. Bot berhenti. - index.js:187");
                        break;
                    default:
                        if (status === 403) {
                            console.error(lastDisconnect.error);
                            fs.rmSync("./session", { recursive: true, force: true });
                        } else {
                            console.error(lastDisconnect.error?.message);
                            connectToWhatsApp();
                        }
                }
            } else if (connection === "open") {
                console.log(`✅ Bot terhubung: ${jidDecode(sock?.user?.id)?.user} - index.js:199`);
                console.log("🟢 Bot siap menerima pesan! - index.js:200");
            }
        }

        // ─── Save Credentials ─────────────────────────────────
        if (ev["creds.update"]) {
            await saveCreds();
        }

        // ─── Messages Upsert ──────────────────────────────────
        const upsert = ev["messages.upsert"];
        if (upsert) {
            if (upsert.type !== "notify") return;
            const message = Messages(upsert, sock);
            if (message.key?.remoteJid === "status@broadcast") return;
            if (
                message.key?.fromMe &&
                !(
                    message.text?.toLowerCase().startsWith(".viewonce") ||
                    message.text?.toLowerCase().startsWith(".del") ||
                    message.text?.toLowerCase().startsWith(".math")
                )
            ) return;
            if (!message) return;

            const handled = await handleSheetCommands(sock, message);
            if (handled) return;

            msgHandler(upsert, sock, message);
        }

        // ─── Auto-reject Calls ────────────────────────────────
        if (ev["call"]) {
            const call = ev["call"];
            const { id, chatId, isGroup } = call[0];
            if (isGroup) return;
            await sock.rejectCall(id, chatId);
            await sock.sendMessage(
                chatId,
                { text: "Maaf, bot tidak bisa menerima panggilan suara/video. 🙏" },
                { ephemeralExpiration: upsert?.messages?.[0]?.contextInfo?.expiration }
            );
        }
    });
}

connectToWhatsApp();

// ─── Keep-alive ping Apps Script tiap 5 menit ──────────────
// Biar Apps Script tidak "tidur" dan cold start tidak bikin timeout.
setInterval(async () => {
    try {
        const url = `${APPS_SCRIPT_URL}?secret=${encodeURIComponent(SHEET_SECRET)}`;
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);
        await fetch(url, { redirect: "follow", signal: controller.signal });
        clearTimeout(t);
        console.log("💓 Keepalive ping OK - index.js:257");
    } catch (e) {
        console.warn("⚠️  Keepalive gagal: - index.js:259", e.message);
    }
}, 5 * 60 * 1000);

// ─── Hot-reload handler.js ─────────────────────────────────
const watcher = chokidar.watch("./handler.js", {
    ignored: /(^|[/\\])\../,
    persistent: true
});

watcher.on("change", async (path) => {
    console.log(`🔄 File ${path} berubah, hotreload handler... - index.js:270`);
    try {
        const newModule = await import(`./handler.js?cacheBust=${Date.now()}`);
        msgHandler = newModule.msgHandler;
        console.log("✅ Handler berhasil diperbarui. - index.js:274");
    } catch (err) {
        console.error("❌ Gagal reload handler: - index.js:276", err);
    }
});