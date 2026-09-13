import {
    getContentType,
    jidNormalizedUser,
    downloadContentFromMessage
} from "baileys";

const mimeMap = {
    imageMessage: "image",
    videoMessage: "video",
    stickerMessage: "sticker",
    documentMessage: "document",
    audioMessage: "audio",
    ptvMessage: "video"
};

const fontMap = {
    system: "abcdefghijklmnopqrstuvwxyz",
    fraktur: "𝔞𝔟𝔠𝔡𝔢𝔣𝔤𝔥𝔦𝔧𝔨𝔩𝔪𝔫𝔬𝔭𝔮𝔯𝔰𝔱𝔲𝔳𝔴𝔵𝔶𝔷",
    bold: "𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇",
};

function replaceFont(str, fontName = "system") {
    const font = fontMap[fontName];
    const system = fontMap.system;
    if (font && font !== system) {
        for (let i = 0; i < system.length; i++) {
            str = String(str).replace(new RegExp(system[i], "gi"), font[i]);
        }
    }
    return str;
}

/**
 * Download media from a message as a Buffer (or save to file).
 */
const downloadMedia = async (message, pathFile) => {
    const type = Object.keys(message)[0];
    try {
        const stream = await downloadContentFromMessage(message[type], mimeMap[type]);
        const buffer = [];
        for await (const chunk of stream) {
            buffer.push(chunk);
        }
        if (pathFile) {
            const fs = await import("fs");
            await fs.promises.writeFile(pathFile, Buffer.concat(buffer));
            return pathFile;
        }
        return Buffer.concat(buffer);
    } catch (e) {
        console.log(message);
        throw e;
    }
};

/**
 * Serialize a raw upsert event into an extended WAMessage object.
 */
export function Serialize(upsert, sock) {
    const { messages } = upsert;
    const m = messages[0];

    if (m.key) {
        const { remoteJid } = m.key;
        m.id = m.key.id;
        m.isGroup = remoteJid.endsWith("@g.us");
        m.chat = jidNormalizedUser(remoteJid);
        m.sender = jidNormalizedUser(
            m.isGroup ? m.key.participant : m.key.fromMe ? sock.user.id : remoteJid
        );
    }

    if (!m.message) return m;

    m.mtype = getContentType(m.message);

    if (m.mtype === "ephemeralMessage") {
        m.message = m.message[m.mtype].message;
        m.mtype = getContentType(m.message);
    }

    if (m.mtype === "viewOnceMessageV2" || m.mtype === "documentWithCaptionMessage") {
        m.message = m.message[m.mtype].message;
    }

    m.mtype = getContentType(m.message);

    try {
        m.contextInfo = m.message[m.mtype]?.contextInfo || {};
        m.mentionedJid = m.contextInfo?.mentionedJid || [];
        m.mentionMe = m.mentionedJid[0] === sock.user.id;

        const quoted = m.contextInfo.quotedMessage || null;
        if (quoted) {
            if (quoted.ephemeralMessage) {
                const type = Object.keys(quoted.ephemeralMessage.message)[0];
                const message =
                    type === "documentMessage"
                        ? quoted.ephemeralMessage.message.documentMessage
                        : quoted.ephemeralMessage.message[type]?.message;
                m.quoted = {
                    participant: jidNormalizedUser(m.contextInfo.participant),
                    message: message || quoted.ephemeralMessage.message,
                };
            } else {
                const type = Object.keys(quoted)[0];
                const message = quoted[type]?.message;
                m.quoted = {
                    participant: jidNormalizedUser(m.contextInfo.participant),
                    message: message || quoted,
                };
            }
            m.quoted.sender = m.quoted.participant;
            m.quoted.mtype = Object.keys(m.quoted.message)[0];
            m.quoted.mentionedJid =
                m.quoted.message[m.quoted.mtype]?.contextInfo?.mentionedJid || [];
            m.quoted.text =
                m.quoted.message?.conversation ||
                m.quoted.message[m.quoted.mtype]?.text ||
                m.quoted.message[m.quoted.mtype]?.caption ||
                "";
            m.quoted.key = {
                id: m.contextInfo.stanzaId,
                fromMe: m.quoted.sender === jidNormalizedUser(sock.user.id),
                remoteJid: m.chat,
                ...(m.isGroup ? { participant: m.contextInfo.participant } : {}),
            };
            m.quoted.mtype =
                m.quoted.message[m.quoted.mtype]?.mimetype ||
                getContentType(m.quoted.message);
        } else {
            m.quoted = null;
        }

        m.text =
            m.message[m.mtype]?.caption ||
            m.message[m.mtype]?.text ||
            m.message[m.mtype]?.conversation ||
            m.message?.conversation ||
            "";

        m.type = m.mtype;
        m.mtype = m.message[m.mtype]?.mimetype || getContentType(m.message);
    } catch (e) {
        console.log(e);
    }

    return m;
}

/**
 * Process an incoming upsert event and return an extended WAMessage with helper methods.
 */
export function Messages(upsert, sock) {
    const m = Serialize(upsert, sock);

    if (m.quoted) {
        m.quoted.react = (emoji) =>
            sock.sendMessage(m.chat, { react: { text: String(emoji), key: m.quoted.key } });
        m.quoted.delete = () => sock.sendMessage(m.chat, { delete: m.quoted.key });
        m.quoted.download = (pathFile) => downloadMedia(m.quoted.message, pathFile);
    }

    m.react = (emoji) =>
        sock.sendMessage(m.chat, { react: { text: String(emoji), key: m.key } });

    m.reply = (text, font) =>
        sock.sendMessage(
            m.chat,
            { text: (font && replaceFont(text, font)) || text },
            { quoted: m, ephemeralExpiration: m.contextInfo?.expiration }
        );

    const replyUpdate = async (text, cb) => {
        const response = await sock.sendMessage(
            m.chat,
            { text: String(text) },
            { quoted: m }
        );
        if (typeof cb === "function") {
            await cb(async (n_text) =>
                sock.sendMessage(m.chat, { text: n_text || "", edit: response.key })
            ).catch(() => {});
        }
        async function update(n_text) {
            await sock.sendMessage(m.chat, { text: String(n_text), edit: response.key });
        }
        return update;
    };
    m.replyUpdate = replyUpdate;
    m.delete = () => sock.sendMessage(m.chat, { delete: m.key });
    m.download = (pathFile) => downloadMedia(m.message, pathFile);

    sock.user.id = jidNormalizedUser(sock.user.id);
    return m;
}
