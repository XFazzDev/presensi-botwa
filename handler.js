import {
    downloadMediaMessage,
    downloadContentFromMessage,
    getContentType,
    generateWAMessageFromContent,
    proto
} from "baileys";
import Pino from "pino";
import moment from "moment-timezone";
import anyAscii from "any-ascii";
import axios from "axios";

import { msgFilter, color } from "./lib/utils.js";
import setting from "./setting.js";

moment.tz.setDefault("Asia/Jakarta").locale("id");

// ─── Helper: Cek Tarif via Komerce API ──────────────────────────────────────
async function cekTarifKomerce(shipperDestId, receiverDestId, weight = 1) {
    try {
        const config = {
            method: 'get',
            maxBodyLength: Infinity,
            url: `https://api-sandbox.collaborator.komerce.id/tariff/api/v1/calculate?shipper_destination_id=${shipperDestId}&receiver_destination_id=${receiverDestId}&weight=${weight}&item_value=300000&cod=no`,
            headers: {
                'x-api-key': process.env.KOMERCE_API_KEY
            }
        };

        const response = await axios.request(config);
        const data = response.data?.data;

        if (!data || data.length === 0) {
            return `❌ Rute tidak ditemukan.\nKetik *${setting.prefix}kota* untuk daftar ID kota.`;
        }

        // Filter hanya J&T, kalau tidak ada tampilkan semua
        const jnt = data.filter(item =>
            item.shipping_name?.toLowerCase().includes("jnt") ||
            item.shipping_name?.toLowerCase().includes("j&t")
        );
        const tampil = jnt.length > 0 ? jnt : data;

        let pesan = `📦 *Tarif Pengiriman*\n`;
        pesan += `🏠 Shipper ID : ${shipperDestId}\n`;
        pesan += `📍 Receiver ID: ${receiverDestId}\n`;
        pesan += `⚖️ Berat      : ${weight} kg\n`;
        pesan += `─────────────────────\n`;

        tampil.forEach(item => {
            pesan += `\n🚚 *${item.shipping_name}* (${item.service_name || item.service_type || ""})\n`;
            pesan += `   💰 Tarif    : Rp ${Number(item.price || item.tariff || 0).toLocaleString("id-ID")}\n`;
            if (item.etd) pesan += `   ⏱️ Estimasi : ${item.etd}\n`;
        });

        pesan += `\n_Data per ${new Date().toLocaleDateString("id-ID")}_`;
        return pesan;

    } catch (error) {
        console.error(color("Error API:", "red"), error.response?.data || error.message);
        return `❌ Gagal mengambil data tarif. Coba beberapa saat lagi.\n_Error: ${error.response?.status || error.message}_`;
    }
}

// ─── Helper: Daftar Kota (Komerce Destination ID) ────────────────────────────
function daftarKota(prefix) {
    return `🗺️ *Destination ID Komerce*\n\n` +
        `*Jawa:*\n` +
        `• 31597 → Purwokerto (Banyumas)\n` +
        `• 46116 → Purbalingga\n` +
        `• 10001 → Jakarta Pusat\n` +
        `• 20001 → Bandung\n` +
        `• 30001 → Surabaya\n` +
        `• 40001 → Yogyakarta\n` +
        `• 50001 → Semarang\n\n` +
        `*Catatan:*\n` +
        `ID kota bisa dicari di API Komerce.\n\n` +
        `_Contoh: ${prefix}cektarif 31597 46116_`;
}

// ─── Helper: Menu Help ────────────────────────────────────────────────────────
function pesanHelp(prefix) {
    return `🤖 *${setting.name}*\n\n` +
        `*Perintah tersedia:*\n` +
        `• *${prefix}cektarif [id asal] [id tujuan] [berat_kg]* — Cek tarif pengiriman\n` +
        `• *${prefix}kota* — Daftar ID kota Komerce\n` +
        `• *${prefix}math* — 🧮 Main game matematika\n` +
        `• *${prefix}mathscore* — 📊 Lihat skor math game\n` +
        `• *${prefix}ping* — Cek bot aktif\n` +
        `• *${prefix}help* — Menu ini\n\n` +
        `*Contoh:*\n` +
        `_${prefix}cektarif 31597 46116_ (Purwokerto → Purbalingga, 1 kg)\n` +
        `_${prefix}cektarif 31597 46116 2_ (2 kg)\n\n` +
        `_Powered by Komerce API_ 📦`;
}

// ─── Konstanta: Nomor yang boleh pakai .viewonce ──────────────────────────────
const VIEWONCE_ALLOWED = ["081217100477", "6281217100477"];

// ─── Math Game: Sessions & Skor ──────────────────────────────────────────────
const mathSessions = new Map();  // key = chatId, value = { result, str, mode, time, bonus, timestamp, timer, userId }
const mathScores = new Map();    // key = senderId, value = { correct, wrong, streak, bestStreak, totalBonus }

const MATH_LEVELS = [
    { id: "noob",        title: "🟢 Noob",         desc: "Sangat mudah, cocok untuk pemula" },
    { id: "easy",        title: "🟡 Easy",         desc: "Mudah, operasi dasar" },
    { id: "medium",      title: "🟠 Medium",       desc: "Sedang, mulai menantang" },
    { id: "hard",        title: "🔴 Hard",         desc: "Sulit, butuh konsentrasi" },
    { id: "extreme",     title: "🔥 Extreme",      desc: "Sangat sulit!" },
    { id: "impossible",  title: "💀 Impossible",   desc: "Hampir mustahil" },
    { id: "impossible2", title: "💀 Impossible 2", desc: "Lebih mustahil lagi" },
    { id: "impossible3", title: "☠️ Impossible 3",  desc: "Level gila" },
    { id: "impossible4", title: "☠️ Impossible 4",  desc: "Level dewa" },
    { id: "impossible5", title: "👑 Impossible 5", desc: "Level legenda, yang terkuat!" },
];

// ─── Helper: Kirim button list pilih level math ──────────────────────────────
async function sendMathLevelButtons(sock, chatId, message) {
    const rows = MATH_LEVELS.map(lv => ({
        title: lv.title,
        description: lv.desc,
        id: `math_level_${lv.id}`
    }));

    const interactiveMsg = {
        body: proto.Message.InteractiveMessage.Body.create({
            text: `🧮 *MATH GAME*\n\nPilih tingkat kesulitan untuk memulai permainan matematika!\n\n🎯 Jawab soal dengan benar sebelum waktu habis.\n💰 Semakin sulit level, semakin besar bonus poin!`
        }),
        footer: proto.Message.InteractiveMessage.Footer.create({
            text: `📊 Ketik .mathscore untuk lihat skor kamu`
        }),
        header: proto.Message.InteractiveMessage.Header.create({
            title: "🎮 Pilih Level",
            hasMediaAttachment: false
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [
                {
                    name: "single_select",
                    buttonParamsJson: JSON.stringify({
                        title: "📋 Pilih Level",
                        sections: [
                            {
                                title: "Tingkat Kesulitan",
                                rows: rows
                            }
                        ]
                    })
                }
            ]
        })
    };

    const msg = generateWAMessageFromContent(
        chatId,
        {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: interactiveMsg
                }
            }
        },
        { userJid: sock.user.id, quoted: message }
    );

    await sock.relayMessage(chatId, msg.message, { messageId: msg.key.id });
}

// ─── Helper: Fetch soal math dari API ────────────────────────────────────────
async function fetchMathQuestion(level) {
    try {
        const res = await axios.get(`https://api.siputzx.my.id/api/games/maths?level=${level}`);
        if (res.data?.status && res.data?.data) {
            return res.data.data;
        }
        return null;
    } catch (err) {
        console.error(color("[MATH API ERROR]", "red"), err.message);
        return null;
    }
}

// ─── Helper: Start math game session ─────────────────────────────────────────
async function startMathGame(sock, chatId, userId, level, message) {
    // Clear existing session if any
    if (mathSessions.has(chatId)) {
        const old = mathSessions.get(chatId);
        if (old.timer) clearTimeout(old.timer);
        mathSessions.delete(chatId);
    }

    const data = await fetchMathQuestion(level);
    if (!data) {
        await sock.sendMessage(chatId, {
            text: "❌ Gagal mengambil soal dari server. Coba lagi nanti."
        }, { quoted: message });
        return;
    }

    const timeoutMs = data.time || 15000;
    const levelInfo = MATH_LEVELS.find(l => l.id === level);

    // Set timer for timeout
    const timer = setTimeout(async () => {
        if (mathSessions.has(chatId)) {
            const session = mathSessions.get(chatId);
            mathSessions.delete(chatId);

            // Update score
            const score = mathScores.get(userId) || { correct: 0, wrong: 0, streak: 0, bestStreak: 0, totalBonus: 0 };
            score.wrong++;
            score.streak = 0;
            mathScores.set(userId, score);

            await sock.sendMessage(chatId, {
                text: `⏰ *WAKTU HABIS!*\n\n` +
                    `Soal: *${session.str}*\n` +
                    `Jawaban: *${session.result}*\n\n` +
                    `❌ Kamu tidak menjawab tepat waktu.\n` +
                    `Ketik *.math* untuk main lagi!`
            });
        }
    }, timeoutMs);

    // Save session
    mathSessions.set(chatId, {
        result: data.result,
        str: data.str,
        mode: data.mode,
        time: timeoutMs,
        bonus: data.bonus || 0,
        timestamp: Date.now(),
        timer: timer,
        userId: userId
    });

    const timeSeconds = (timeoutMs / 1000).toFixed(0);
    await sock.sendMessage(chatId, {
        text: `🧮 *MATH GAME* — ${levelInfo?.title || level}\n\n` +
            `📝 Soal:\n\n` +
            `*${data.str} = ?*\n\n` +
            `⏱️ Waktu: *${timeSeconds} detik*\n` +
            `💰 Bonus: *+${data.bonus || 0} poin*\n\n` +
            `_Ketik jawabanmu sekarang!_`
    }, { quoted: message });
}

// ─── Helper: Cek jawaban math ────────────────────────────────────────────────
async function checkMathAnswer(sock, chatId, userId, answer, message) {
    const session = mathSessions.get(chatId);
    if (!session) return false;
    if (session.userId !== userId) return false;

    const userAnswer = parseFloat(answer);
    if (isNaN(userAnswer)) return false;

    // Clear timer
    if (session.timer) clearTimeout(session.timer);
    mathSessions.delete(chatId);

    const elapsed = ((Date.now() - session.timestamp) / 1000).toFixed(1);
    const score = mathScores.get(userId) || { correct: 0, wrong: 0, streak: 0, bestStreak: 0, totalBonus: 0 };

    if (userAnswer === session.result) {
        score.correct++;
        score.streak++;
        score.totalBonus += (session.bonus || 0);
        if (score.streak > score.bestStreak) score.bestStreak = score.streak;
        mathScores.set(userId, score);

        const streakEmoji = score.streak >= 5 ? "🔥🔥🔥" : score.streak >= 3 ? "🔥🔥" : score.streak >= 2 ? "🔥" : "";

        await sock.sendMessage(chatId, {
            text: `✅ *BENAR!* ${streakEmoji}\n\n` +
                `Soal: *${session.str} = ${session.result}*\n` +
                `⏱️ Waktu: *${elapsed} detik*\n` +
                `💰 Bonus: *+${session.bonus} poin*\n` +
                `🔥 Streak: *${score.streak}x*\n\n` +
                `📊 Skor kamu: ✅ ${score.correct} | ❌ ${score.wrong}\n\n` +
                `Ketik *.math* untuk main lagi!`
        }, { quoted: message });
    } else {
        score.wrong++;
        score.streak = 0;
        mathScores.set(userId, score);

        await sock.sendMessage(chatId, {
            text: `❌ *SALAH!*\n\n` +
                `Soal: *${session.str}*\n` +
                `Jawabanmu: *${userAnswer}*\n` +
                `Jawaban benar: *${session.result}*\n` +
                `⏱️ Waktu: *${elapsed} detik*\n\n` +
                `📊 Skor kamu: ✅ ${score.correct} | ❌ ${score.wrong}\n\n` +
                `Ketik *.math* untuk main lagi!`
        }, { quoted: message });
    }

    return true;
}

// ─── Helper: Download view-once dari contextInfo.quotedMessage ────────────────
async function downloadViewOnce(quotedMsg) {
    // quotedMsg adalah contextInfo.quotedMessage dari pesan yang me-reply view-once
    let inner = quotedMsg;

    // Unwrap viewOnceMessage / viewOnceMessageV2 / viewOnceMessageV2Extension
    for (const key of [
        "viewOnceMessage",
        "viewOnceMessageV2",
        "viewOnceMessageV2Extension"
    ]) {
        if (inner[key]) {
            inner = inner[key].message;
            break;
        }
    }

    const mediaTypes = ["imageMessage", "videoMessage"];
    const mediaKey = mediaTypes.find(k => inner[k]);
    if (!mediaKey) return null;

    const mediaMsg = inner[mediaKey];
    const mimeType = mediaMsg.mimetype || "";
    const caption = mediaMsg.caption || "";
    const mediaType = mediaKey === "imageMessage" ? "image" : "video";

    const stream = await downloadContentFromMessage(mediaMsg, mediaType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), mimeType, mediaKey, caption };
}

// ─── Message Handler Utama ───────────────────────────────────────────────────
let msgHandler = async (upsert, sock, message) => {
    try {
        const { text } = message;
        if (message.sender === "") return;

        const t = message.messageTimestamp;
        const isGroup = message.isGroup;

        const groupMetadata = isGroup
            ? await sock.groupMetadata(message.chat)
            : {};

        let sender = message.key.addressingMode === "pn"
            ? message.sender
            : message.key.remoteJidAlt || message.sender;

        let isGroupAdmins = false;
        let isBotGroupAdmins = false;
        if (isGroup) {
            if (message.key.addressingMode === "pn") {
                isGroupAdmins = groupMetadata.participants
                    ?.filter(p => p.admin)
                    .map(p => p.id)
                    .includes(sender) || false;
                isBotGroupAdmins = groupMetadata.participants
                    ?.filter(p => p.admin)
                    .map(p => p.id)
                    .includes(sock.user.id) || false;
            } else {
                isGroupAdmins = groupMetadata.participants
                    ?.filter(p => p.admin)
                    .map(p => p.phoneNumber)
                    .includes(sender) || false;
            }
        }

        const groupName = isGroup ? groupMetadata.subject : "";
        const pushname = message.pushName || sender;
        if (!sender) return;

        const prefix = setting.prefix;
        let budy = typeof text === "string" ? text : "";
        const cmd = budy || "";

        let command;
        if (cmd.startsWith(". ") || cmd.startsWith("! ") || cmd.startsWith("# ") || cmd.startsWith("/ ")) {
            const parts = cmd.toLowerCase().split(" ");
            command = parts[0] + parts[1];
        } else {
            command = cmd.toLowerCase().split(" ")[0] || "";
        }
        command = anyAscii(command).toLowerCase();
        const isCmd = budy.startsWith(prefix);
        let args;
        if (cmd.startsWith(". ") || cmd.startsWith("! ") || cmd.startsWith("# ") || cmd.startsWith("/ ")) {
            args = budy.trim().split(/ +/).slice(2);
        } else {
            args = budy.trim().split(/ +/).slice(1);
        }
        const q = args.join(" ");

        // Spam filter
        if (isCmd && msgFilter.isFiltered(message.chat) && !isGroup) {
            return console.log(color("[SPAM]", "red"), color(moment(t * 1000).format("DD/MM/YY HH:mm:ss"), "yellow"), color(`${command} [${args.length}]`), "from", color(pushname));
        }
        if (isCmd && msgFilter.isFiltered(message.chat) && isGroup) {
            return console.log(color("[SPAM]", "red"), color(moment(t * 1000).format("DD/MM/YY HH:mm:ss"), "yellow"), color(`${command} [${args.length}]`), "from", color(pushname), "in", color(groupName));
        }

        if (budy.toLowerCase().includes("faiz") || budy.toLowerCase().includes("fais")) {
            try { await message.react("✌️"); } catch (err) {}
        }

        // ─── Cek jawaban math game (sebelum filter isCmd) ────────────────
        if (!isCmd && mathSessions.has(message.chat)) {
            const session = mathSessions.get(message.chat);
            if (session.userId === sender) {
                const numAnswer = budy.trim();
                if (/^-?\d+(\.\d+)?$/.test(numAnswer)) {
                    const handled = await checkMathAnswer(sock, message.chat, sender, numAnswer, message);
                    if (handled) return;
                }
            }
        }

        // ─── Cek response dari button interactive (math level select) ────
        if (!isCmd) {
            const rawMsg = message.message || {};
            // Check for interactiveResponseMessage -> nativeFlowResponseMessage
            const interactiveResponse = rawMsg.interactiveResponseMessage;
            if (interactiveResponse) {
                const nativeFlow = interactiveResponse.nativeFlowResponseMessage;
                if (nativeFlow) {
                    try {
                        const params = JSON.parse(nativeFlow.paramsJson || "{}");
                        const selectedId = params.id || "";
                        if (selectedId.startsWith("math_level_")) {
                            const level = selectedId.replace("math_level_", "");
                            await startMathGame(sock, message.chat, sender, level, message);
                            return;
                        }
                    } catch (e) {
                        console.log(color("[BUTTON PARSE ERROR]", "red"), e.message);
                    }
                }
            }
        }

        if (!isCmd && !isGroup) return;
        if (!isCmd && isGroup) return;
        if (isCmd && !isGroup) {
            console.log(color("[EXEC]"), color(moment(t * 1000).format("DD/MM/YY HH:mm:ss"), "yellow"), color(`${command} [${args.length}]`), "from", color(pushname));
        }
        if (isCmd && isGroup) {
            console.log(color("[EXEC]"), color(moment(t * 1000).format("DD/MM/YY HH:mm:ss"), "yellow"), color(`${command} [${args.length}]`), "from", color(pushname), "in", color(groupName));
        }

        await sock.readMessages([message.key]); // Auto-read

        msgFilter.addFilter(message.chat, 3000); // 3 detik cooldown

        // ─── Fitur / Commands ────────────────────────────────────────────
        switch (command) {
            case prefix + "ping":
            case prefix + "test":
            case prefix + "tes":
                await message.reply(`🟢 Pong! 🏓\n\nSpeed: ${Date.now() - t * 1000} ms`);
                break;

            case prefix + "help":
            case prefix + "menu":
                await message.reply(pesanHelp(prefix));
                break;

            case prefix + "kota":
                await message.reply(daftarKota(prefix));
                break;

            case prefix + "cektarif": {
                if (args.length < 2) {
                    await message.reply(
                        `⚠️ Format salah!\n\nGunakan: *${prefix}cektarif [id asal] [id tujuan] [berat kg]*\nContoh: _${prefix}cektarif 31597 46116_\n\nKetik *${prefix}kota* untuk daftar ID kota.`
                    );
                    break;
                }
                const beratKg = args[2] ? parseFloat(args[2]) : 1;
                await message.reply(`🔍 Mengecek tarif (${beratKg} kg), mohon tunggu...`);
                const hasil = await cekTarifKomerce(args[0], args[1], beratKg);
                await message.reply(hasil);
                break;
            }

            case prefix + "viewonce": {
                // ─── Cek izin ───────────────────────────────────────────────
                const senderNum = sender.replace(/[^0-9]/g, "");
                const ownerNum = setting.owner.replace(/[^0-9]/g, "");
                const isAllowed = VIEWONCE_ALLOWED.some(n => senderNum.endsWith(n.replace(/^0/, "")) || senderNum === n);
                const isOwner = senderNum.endsWith(ownerNum.replace(/^0/, "")) || senderNum === ownerNum;

                if (!isAllowed && !isOwner) {
                    await message.reply("⛔ Kamu tidak punya izin untuk menggunakan perintah ini.");
                    break;
                }

                // ─── Cek ada quoted message ──────────────────────────────────
                const rawQuoted = message.contextInfo?.quotedMessage;
                if (!rawQuoted) {
                    await message.reply(`⚠️ Reply pesan gambar/video sekali lihat yang ingin dilihat, lalu ketik *${prefix}viewonce*`);
                    break;
                }

                try {
                    const result = await downloadViewOnce(rawQuoted);
                    if (!result) {
                        await message.reply("❌ Tidak ada media gambar/video di pesan yang direply.");
                        break;
                    }

                    const { buffer, mimeType, mediaKey, caption } = result;
                    const textCaption = caption ? `📝 *Caption:*\n${caption}` : (mediaKey === "imageMessage" ? "📷 View-once image" : "🎥 View-once video");

                    if (mediaKey === "imageMessage") {
                        await sock.sendMessage(
                            message.chat,
                            { image: buffer, mimetype: mimeType, caption: textCaption },
                            { quoted: message }
                        );
                    } else {
                        await sock.sendMessage(
                            message.chat,
                            { video: buffer, mimetype: mimeType, caption: textCaption },
                            { quoted: message }
                        );
                    }
                } catch (e) {
                    console.log(color("[VIEWONCE ERROR]", "red"), e.message);
                    await message.reply("❌ Gagal mengambil media. Pastikan kamu reply pesan view-once yang belum kadaluarsa.");
                }
                break;
            }

            case prefix + "del":
            case prefix + "delete": {
                // ─── Cek izin ───────────────────────────────────────────────
                const senderNum = sender.replace(/[^0-9]/g, "");
                const ownerNum = setting.owner.replace(/[^0-9]/g, "");
                const isAllowed = VIEWONCE_ALLOWED.some(n => senderNum.endsWith(n.replace(/^0/, "")) || senderNum === n);
                const isOwner = senderNum.endsWith(ownerNum.replace(/^0/, "")) || senderNum === ownerNum;
                
                if (!isAllowed && !isOwner) {
                    await message.reply("⛔ Kamu tidak punya izin untuk menggunakan perintah ini.");
                    break;
                }

                if (!message.quoted) {
                    await message.reply(`⚠️ Reply pesan yang ingin dihapus, lalu ketik *${prefix}del*`);
                    break;
                }

                try {
                    await message.quoted.delete();
                } catch (err) {
                    console.log(color("[DELETE ERROR]", "red"), err.message);
                    await message.reply("❌ Gagal menghapus pesan. Pastikan bot memiliki hak akses yang cukup.");
                }
                break;
            }

            case prefix + "math":
            case prefix + "matematika":
            case prefix + "mathgame": {
                try {
                    await sendMathLevelButtons(sock, message.chat, message);
                } catch (err) {
                    console.log(color("[MATH BUTTON ERROR]", "red"), err.message);
                    // Fallback: kirim sebagai text biasa kalau interactive gagal
                    let fallbackText = `🧮 *MATH GAME*\n\nPilih level dengan mengetik:\n\n`;
                    MATH_LEVELS.forEach((lv, i) => {
                        fallbackText += `*${prefix}mathplay ${lv.id}* → ${lv.title} - ${lv.desc}\n`;
                    });
                    fallbackText += `\nContoh: _${prefix}mathplay noob_`;
                    await message.reply(fallbackText);
                }
                break;
            }

            case prefix + "mathplay": {
                if (!args[0]) {
                    await message.reply(`⚠️ Ketik level yang diinginkan!\nContoh: *${prefix}mathplay noob*\n\nLevel: noob, easy, medium, hard, extreme, impossible, impossible2, impossible3, impossible4, impossible5`);
                    break;
                }
                const level = args[0].toLowerCase();
                const validLevel = MATH_LEVELS.find(l => l.id === level);
                if (!validLevel) {
                    await message.reply(`❌ Level *${args[0]}* tidak valid!\n\nLevel yang tersedia:\nnoob, easy, medium, hard, extreme, impossible, impossible2, impossible3, impossible4, impossible5`);
                    break;
                }
                await startMathGame(sock, message.chat, sender, level, message);
                break;
            }

            case prefix + "mathscore":
            case prefix + "skoremath": {
                const score = mathScores.get(sender);
                if (!score) {
                    await message.reply(`📊 Kamu belum pernah bermain Math Game.\nKetik *${prefix}math* untuk mulai!`);
                    break;
                }
                const total = score.correct + score.wrong;
                const accuracy = total > 0 ? ((score.correct / total) * 100).toFixed(1) : 0;
                await message.reply(
                    `📊 *MATH GAME — Skor Kamu*\n\n` +
                    `👤 ${pushname}\n` +
                    `─────────────────────\n` +
                    `✅ Benar     : *${score.correct}*\n` +
                    `❌ Salah     : *${score.wrong}*\n` +
                    `📝 Total     : *${total}*\n` +
                    `🎯 Akurasi   : *${accuracy}%*\n` +
                    `🔥 Streak    : *${score.streak}x*\n` +
                    `🏆 Best Streak: *${score.bestStreak}x*\n` +
                    `💰 Total Bonus: *${score.totalBonus} poin*\n` +
                    `─────────────────────\n\n` +
                    `Ketik *${prefix}math* untuk main lagi!`
                );
                break;
            }

            default:
                if (isCmd) {
                    console.log(color("[ERROR]", "red"), color(moment(t * 1000).format("DD/MM/YY HH:mm:ss"), "yellow"), "Unregistered Command from", color(pushname));
                }
                break;
        }

    } catch (err) {
        console.log(color("[ERROR]", "red"), err);
    }
};

export { msgHandler };
export default { msgHandler };
