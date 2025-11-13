// ====== index.js ======
import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

// === CEK API KEY ===
if (!process.env.GOOGLEAI_API_KEY) {
  console.error("❌ API Key Gemini tidak ditemukan! Cek file .env");
  process.exit(1);
}
if (!process.env.UNSPLASH_ACCESS_KEY) {
  console.error("❌ Unsplash Access Key tidak ditemukan! Tambahkan di .env");
  process.exit(1);
}

console.log("✅ API Key Gemini & Unsplash terbaca");

// === INISIALISASI GEMINI ===
const genAI = new GoogleGenerativeAI(process.env.GOOGLEAI_API_KEY);
const textModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// === FUNGSI CARI GAMBAR ===
async function cariGambar(prompt) {
  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(prompt)}&per_page=5`,
      { headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } }
    );

    const data = await res.json();
    if (data.results?.length > 0) {
      const randomIndex = Math.floor(Math.random() * data.results.length);
      return data.results[randomIndex].urls.small;
    }
    return null;
  } catch (e) {
    console.error("❌ Error cariGambar:", e);
    return null;
  }
}

// === MULAI BOT ===
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger: P({ level: "silent" })
  });

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log("📱 Scan QR berikut untuk login WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Koneksi terputus:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔄 Menghubungkan ulang...");
        start();
      } else {
        console.log("❌ Kamu logout. Hapus folder auth dan jalankan ulang bot.");
      }
    } else if (connection === "open") {
      console.log("✅ BOT SUDAH TERHUBUNG!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // === PESAN MASUK ===
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    if (!text) return;

    console.log(`📩 Pesan dari ${sender}:`, text);

    // ===== Bersihkan teks untuk query gambar =====
    let cleaned = text.toLowerCase();
    cleaned = cleaned.replace(/(tolong|buatkan|kirim|gambar|foto|gambarin|dong|ya|please)/g, "");
    cleaned = cleaned.trim();

    try {
      // ===== Prompt untuk menentukan mode =====
      const prompt = `
Kamu adalah asisten WhatsApp ramah.
Tugasmu:
- Jika pengguna meminta gambar atau foto, balas dengan satu kata saja: GAMBAR_MODE.
- Jika pengguna bertanya, balas dengan jawaban informatif & singkat.
Pesan pengguna: "${text}"
`;

      const result = await textModel.generateContent(prompt);
      const reply = result.response.text().trim();

      // ===== Jika perlu kirim gambar =====
      if (reply.includes("GAMBAR_MODE")) {
        // Gunakan Gemini untuk perjelas query
        const clarify = await textModel.generateContent(`
Tugas kamu hanya satu:
Ambil inti dari kalimat berikut dan ubah menjadi 1-3 kata kunci bahasa Inggris
yang cocok untuk pencarian gambar di Unsplash.
Jangan beri penjelasan, jangan gunakan bullet, jangan buat paragraf.
Kalimat: "${text}"
`);
const clarifiedQuery = clarify.response.text().replace(/[*_`]/g, "").trim();
 

        console.log("🔍 Query gambar:", clarifiedQuery);

        const imageUrl = await cariGambar(clarifiedQuery || cleaned || "random");

        if (imageUrl) {
          await sock.sendMessage(sender, {
            image: { url: imageUrl },
            caption: `🖼️ Hasil pencarian dari Unsplash untuk: *${clarifiedQuery || cleaned}*`
          });
        } else {
          await sock.sendMessage(sender, {
            text: `⚠️ Maaf, tidak ditemukan gambar untuk: *${clarifiedQuery || cleaned}*`
          });
        }
      } else {
        // ===== Jawaban teks biasa =====
        await sock.sendMessage(sender, { text: reply });
      }
    } catch (err) {
      console.error("❌ Error Gemini:", err.message || err);
      await sock.sendMessage(sender, {
        text: "⚠️ Terjadi error saat menghubungi Gemini. Pastikan API Key valid dan model tersedia."
      });
    }
  });
}

start();
