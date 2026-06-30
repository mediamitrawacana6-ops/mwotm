const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ── Konfigurasi ───────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const ORG_NAMA         = process.env.ORG_NAMA || 'Organisasi';
const TEMA_WARNA       = process.env.TEMA_WARNA || '#e0457a';
const FOOTER_SOCMED    = process.env.FOOTER_SOCMED || '';
const FONNTE_TOKEN     = process.env.FONNTE_TOKEN || '';
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY || '';
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '';
const GOOGLE_SA_JSON   = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ''; // isi JSON service account (string)
const WEBSITE_BASE_URL = process.env.WEBSITE_BASE_URL || 'https://mitrawacana.or.id'; // sumber sinkronisasi berita kegiatan
const WEBSITE_KATEGORI_SLUG = process.env.WEBSITE_KATEGORI_SLUG || 'berita'; // hanya ambil dari kategori ini

const DATA_FILE = './data/kegiatan.json';
if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });

// ── Logo organisasi (watermark di web & carousel Instagram) ──
// Diambil dari repo GitHub publik, dengan fallback ke file lokal assets/logo_mw.png jika ada.
const LOGO_URL_PUBLIK = 'https://raw.githubusercontent.com/mediamitrawacana6-ops/mwotm/main/logo_mw.png';
const LOGO_PATH_LOKAL = path.join(__dirname, 'assets', 'logo_mw.png');
let LOGO_BASE64 = null; // dipakai untuk embed di gambar carousel (SVG → PNG via sharp)

async function muatLogo() {
  try {
    if (fs.existsSync(LOGO_PATH_LOKAL)) {
      LOGO_BASE64 = `data:image/png;base64,${fs.readFileSync(LOGO_PATH_LOKAL).toString('base64')}`;
      console.log('✅ Logo dimuat dari file lokal assets/logo_mw.png');
      return;
    }
  } catch (e) {
    console.error('⚠️  Gagal baca logo lokal:', e.message);
  }
  try {
    const res = await axios.get(LOGO_URL_PUBLIK, { responseType: 'arraybuffer', timeout: 10000 });
    LOGO_BASE64 = `data:image/png;base64,${Buffer.from(res.data).toString('base64')}`;
    console.log('✅ Logo dimuat dari GitHub');
  } catch (e) {
    console.error('⚠️  Gagal muat logo dari GitHub:', e.message);
  }
}

// ── Google Drive setup ────────────────────────────────────
let driveClient = null;

function getDrive() {
  if (driveClient) return driveClient;
  if (!GOOGLE_SA_JSON) {
    console.warn('⚠️  GOOGLE_SERVICE_ACCOUNT_JSON belum diisi — fitur foto tidak akan berfungsi.');
    return null;
  }
  try {
    const credentials = JSON.parse(GOOGLE_SA_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      // Scope penuh "drive" diperlukan karena file backup di-share manual oleh admin
      // (bukan dibuat sendiri oleh service account). Scope "drive.file" yang lebih sempit
      // hanya mengizinkan akses ke file yang dibuat oleh app itu sendiri, walau status
      // share-nya sudah "Editor" — makanya backup gagal sebelumnya.
      scopes: [
        'https://www.googleapis.com/auth/drive',
      ],
    });
    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
  } catch (e) {
    console.error('❌ Gagal parse GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
    return null;
  }
}

// ── Ambil daftar foto di folder Drive yang belum dipakai ──
async function ambilFotoBelumDipakai(idYangSudahDipakai = []) {
  const drive = getDrive();
  if (!drive || !GDRIVE_FOLDER_ID) return [];

  try {
    const res = await drive.files.list({
      q: `'${GDRIVE_FOLDER_ID}' in parents and trashed = false and mimeType contains 'image/'`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 20,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const semua = res.data.files || [];
    return semua.filter(f => !idYangSudahDipakai.includes(f.id));
  } catch (e) {
    console.error('❌ Gagal ambil daftar foto Drive:', e.message);
    return [];
  }
}

// ── AI: cocokkan teks kegiatan dengan foto yang paling relevan ──
async function cocokkanFotoDenganAI(teksKegiatan, daftarFoto) {
  if (!daftarFoto.length) return null;
  if (!ANTHROPIC_KEY) return daftarFoto[0]; // fallback: ambil yang terbaru

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const daftarStr = daftarFoto
      .map((f, i) => `${i+1}. nama file: "${f.name}", diupload: ${f.createdTime}`)
      .join('\n');

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: `Ada teks laporan kegiatan: "${teksKegiatan.slice(0,300)}"\n\nBerikut daftar foto yang tersedia di folder Drive (belum terpakai):\n${daftarStr}\n\nMana NOMOR foto yang paling cocok dengan kegiatan di atas, berdasarkan kemiripan nama file dengan isi teks? Jika tidak ada yang relevan sama sekali, jawab "0". Jawab HANYA dengan angka saja, tanpa penjelasan.`
      }]
    });
    const jawaban = resp.content[0].text.trim();
    const idx = parseInt(jawaban, 10);
    if (!idx || idx < 1 || idx > daftarFoto.length) return null;
    return daftarFoto[idx - 1];
  } catch (e) {
    console.error('❌ Gagal cocokkan foto dengan AI:', e.message);
    return null;
  }
}

// ── Cari & siapkan foto yang cocok untuk kegiatan, set permission publik ──
async function cariFotoUntukKegiatan(teksKegiatan, idYangSudahDipakai = []) {
  const drive = getDrive();
  if (!drive) return null;

  const daftarFoto = await ambilFotoBelumDipakai(idYangSudahDipakai);
  if (!daftarFoto.length) return null;

  const fotoTerpilih = await cocokkanFotoDenganAI(teksKegiatan, daftarFoto);
  if (!fotoTerpilih) return null;

  await drive.permissions.create({
    fileId: fotoTerpilih.id,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  }).catch(() => {});

  return {
    fileId: fotoTerpilih.id,
    fileName: fotoTerpilih.name,
    directUrl: `https://lh3.googleusercontent.com/d/${fotoTerpilih.id}=w1000`,
  };
}

async function uploadKeDrive(buffer, filename, mimeType = 'image/jpeg') {
  const drive = getDrive();
  if (!drive) return null;

  try {
    const fileMetadata = {
      name: filename,
      parents: GDRIVE_FOLDER_ID ? [GDRIVE_FOLDER_ID] : undefined,
    };
    const media = {
      mimeType,
      body: require('stream').Readable.from(buffer),
    };
    const res = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, webViewLink, webContentLink',
      supportsAllDrives: true,
    });

    // Buat file bisa diakses publik (read-only) supaya bisa ditampilkan di e-magazine
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });

    const fileId = res.data.id;
    // URL langsung untuk ditampilkan sebagai <img> — endpoint thumbnail Google lebih andal
    const directUrl = `https://lh3.googleusercontent.com/d/${fileId}=w1000`;
    return { fileId, directUrl, viewLink: res.data.webViewLink };
  } catch (e) {
    console.error('❌ Gagal upload ke Drive:', e.message);
    return null;
  }
}

// ── Download isi file dari Drive sebagai buffer ───────────
async function downloadDriveFile(fileId) {
  const drive = getDrive();
  if (!drive) return null;
  try {
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  } catch (e) {
    console.error('❌ Gagal download isi file dari Drive:', e.message);
    return null;
  }
}

// ── Load/save data lokal (metadata kegiatan) ──────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  backupDataKeDrive(data).catch(e => console.error('❌ Gagal backup data ke Drive:', e.message));
}

// ── Backup & restore kegiatan.json ke/dari Google Drive ────
// Render free/standard web service punya disk sementara (hilang tiap redeploy/restart).
// Supaya data tidak hilang, kita simpan salinan kegiatan.json di Google Drive juga.
const BACKUP_FILENAME = 'kegiatan_backup.json';
let backupFileId = null; // cache id file backup di Drive, biar tidak perlu cari ulang tiap kali

async function cariFileBackupDiDrive(drive) {
  if (backupFileId) return backupFileId;
  const q = `name = '${BACKUP_FILENAME}' and trashed = false` +
    (GDRIVE_FOLDER_ID ? ` and '${GDRIVE_FOLDER_ID}' in parents` : '');
  const res = await drive.files.list({
    q, fields: 'files(id, name)', pageSize: 1,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  const file = (res.data.files || [])[0];
  backupFileId = file ? file.id : null;
  return backupFileId;
}

async function backupDataKeDrive(data) {
  const drive = getDrive();
  if (!drive) return; // tidak ada koneksi Drive, lewati saja
  const isi = JSON.stringify(data, null, 2);
  const media = { mimeType: 'application/json', body: require('stream').Readable.from(isi) };

  const idLama = await cariFileBackupDiDrive(drive);
  if (idLama) {
    // Update isi file yang SUDAH ADA (dimiliki akun manusia) — ini tidak butuh kuota dari service account.
    await drive.files.update({ fileId: idLama, media, supportsAllDrives: true });
  } else {
    // Service account TIDAK BISA membuat file baru di "My Drive" pribadi (kuota 0 byte).
    // Solusi: siapkan file kosong secara manual sekali saja, lalu share Editor ke service account.
    console.error(
      `❌ Backup gagal: file "${BACKUP_FILENAME}" belum ada di folder Drive.\n` +
      `   → Buat 1 file kosong bernama "${BACKUP_FILENAME}" manual di folder Drive kamu (isi cukup "[]"),\n` +
      `   → lalu share file itu ke email service account dengan akses Editor.\n` +
      `   → Setelah itu sistem akan otomatis meng-update isinya setiap ada kegiatan baru.`
    );
  }
}

async function restoreDataDariDrive() {
  // Kalau file lokal sudah ada isinya, tidak perlu restore (hindari menimpa data yang baru saja ditulis).
  if (fs.existsSync(DATA_FILE)) {
    try {
      const isi = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(isi) && isi.length > 0) {
        console.log(`ℹ️  Data lokal sudah ada (${isi.length} kegiatan), lewati restore dari Drive.`);
        return;
      }
    } catch {}
  }

  const drive = getDrive();
  if (!drive) return;

  try {
    const idBackup = await cariFileBackupDiDrive(drive);
    if (!idBackup) {
      console.log('ℹ️  Belum ada backup di Drive — mulai dari data kosong.');
      return;
    }
    const res = await drive.files.get({ fileId: idBackup, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
    const isi = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    fs.writeFileSync(DATA_FILE, isi);
    const parsed = JSON.parse(isi);
    console.log(`✅ Data berhasil dipulihkan dari Drive (${Array.isArray(parsed) ? parsed.length : 0} kegiatan).`);
  } catch (e) {
    console.error('❌ Gagal restore data dari Drive:', e.message);
  }
}

// ── Format tanggal Indonesia ───────────────────────────────
function formatTanggal(date = new Date()) {
  const bln = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  return `${date.getDate()} ${bln[date.getMonth()]} ${date.getFullYear()}`;
}

// ── AI: buat deskripsi dari foto ──────────────────────────
async function buatDeskripsi(imageBase64, captionText) {
  if (!ANTHROPIC_KEY) return captionText || '(Deskripsi belum tersedia — tambahkan ANTHROPIC_API_KEY)';
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const prompt = captionText
      ? `Ini foto kegiatan organisasi dengan keterangan: "${captionText}". Buat 1 paragraf deskripsi (3-4 kalimat) Bahasa Indonesia profesional tentang kegiatan ini — apa yang terjadi, siapa terlibat, tujuannya. Langsung paragrafnya saja tanpa kata pengantar.`
      : `Ini foto kegiatan organisasi. Buat 1 paragraf deskripsi (3-4 kalimat) Bahasa Indonesia profesional tentang apa yang terlihat, siapa terlibat, tujuan kegiatan. Langsung paragrafnya saja tanpa kata pengantar.`;

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    });
    return resp.content[0].text.trim();
  } catch (e) {
    console.error('AI error:', e.message);
    return captionText || '(Gagal membuat deskripsi otomatis)';
  }
}

async function ekstrakJudul(teks) {
  if (!ANTHROPIC_KEY) return teks.slice(0, 60);
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `Dari teks kegiatan berikut, buat judul singkat maksimal 10 kata yang menangkap inti kegiatan (tanpa tanda kutip, tanpa penjelasan tambahan, tanpa kata "Kegiatan" di awal kecuali memang perlu):\n"${teks.slice(0,400)}"`
      }]
    });
    return resp.content[0].text.trim().replace(/^["']|["']$/g,'');
  } catch {
    return teks.slice(0, 60);
  }
}

// ── AI: rapikan teks mentah jadi deskripsi 1 paragraf ─────
async function rapikanDeskripsi(teksMentah) {
  if (!ANTHROPIC_KEY) return teksMentah;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Rapikan teks kegiatan organisasi berikut menjadi 1 paragraf deskripsi (3-4 kalimat) Bahasa Indonesia yang profesional dan jelas. Pertahankan semua fakta penting (siapa, apa, kapan, di mana, tujuan) — jangan menambah informasi baru yang tidak ada di teks asli. Langsung tulis paragrafnya saja tanpa kata pengantar:\n\n"${teksMentah.slice(0,500)}"`
      }]
    });
    return resp.content[0].text.trim();
  } catch (e) {
    console.error('AI rapikan error:', e.message);
    return teksMentah;
  }
}

// ── Download media dari Fonnte ────────────────────────────
async function downloadMediaFonnte(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(res.data);
  } catch (e) {
    console.error('❌ Gagal download media:', e.message);
    return null;
  }
}

// ── Kirim balasan via Fonnte ───────────────────────────────
async function kirimBalasanWA(target, message) {
  if (!FONNTE_TOKEN) return;
  try {
    await axios.post('https://api.fonnte.com/send', {
      target,
      message,
    }, {
      headers: { Authorization: FONNTE_TOKEN },
    });
  } catch (e) {
    console.error('❌ Gagal kirim balasan WA:', e.message);
  }
}

// ── WEBHOOK: terima pesan dari Fonnte ─────────────────────
app.post('/webhook/fonnte', async (req, res) => {
  res.sendStatus(200); // balas cepat ke Fonnte dulu

  try {
    const body = req.body;
    console.log('📩 Webhook masuk:', JSON.stringify(body).slice(0, 300));

    // Fonnte mengirim field: device, sender, message, name, url (jika ada media), isgroup, dst
    const isGroup   = body.isgroup === 'true' || body.isgroup === true;
    if (!isGroup) {
      console.log('   (dilewati — bukan pesan grup)');
      return;
    }

    // Fonnte mengirim field attachment (url, filename, extension) HANYA jika
    // device memakai paket berbayar yang mendukung attachment.
    // Paket gratis/trial TIDAK akan pernah mengisi field ini.
    const sender    = body.sender || body.from || '';
    const pesanTeks = body.message || '';
    const mediaUrl  = body.url || '';
    const tanggal   = formatTanggal(new Date());

    if (!mediaUrl && !pesanTeks) {
      console.log('   (dilewati — tidak ada teks maupun media di payload)');
      return;
    }

    // ── Pesan dengan FOTO langsung (hanya jika paket Fonnte mendukung) ──
    if (mediaUrl) {
      console.log(`📸 Foto masuk dari grup, tanggal ${tanggal}...`);
      const buffer = await downloadMediaFonnte(mediaUrl);
      if (!buffer) return;

      const imageBase64 = buffer.toString('base64');
      const deskripsi    = await buatDeskripsi(imageBase64, pesanTeks);
      const judul        = await ekstrakJudul(deskripsi);

      const filename = `kegiatan_${Date.now()}.jpg`;
      const driveResult = await uploadKeDrive(buffer, filename);

      const data = loadData();
      data.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        tanggal,
        timestamp: Math.floor(Date.now()/1000),
        judul,
        deskripsi,
        foto: driveResult ? driveResult.directUrl : null,
        fotoDriveId: driveResult ? driveResult.fileId : null,
        sumber: 'wa_foto',
      });
      saveData(data);

      await kirimBalasanWA(sender, `✅ Kegiatan "${judul}" (${tanggal}) berhasil disimpan untuk e-magazine!`);
      console.log(`   ✅ Disimpan: "${judul}"`);
    }

    // ── Pesan TEKS dengan hashtag — AI cari foto paling relevan dari Drive ──
    else if (pesanTeks && (pesanTeks.toLowerCase().includes('#kegiatan') || pesanTeks.toLowerCase().includes('#rekap'))) {
      console.log(`📝 Teks kegiatan masuk, tanggal ${tanggal}...`);

      const bersih = pesanTeks.replace(/#kegiatan|#rekap/gi, '').trim();

      // Cari foto yang paling relevan dari folder Drive (yang belum dipakai)
      const idFotoTerpakai = loadData()
        .map(d => d.fotoDriveId)
        .filter(Boolean);
      const fotoCocok = await cariFotoUntukKegiatan(bersih, idFotoTerpakai);

      let deskripsi;
      if (fotoCocok) {
        console.log(`   🖼️ Foto cocok ditemukan: "${fotoCocok.fileName}"`);
        const fotoBuffer = await downloadDriveFile(fotoCocok.fileId);
        deskripsi = fotoBuffer
          ? await buatDeskripsi(fotoBuffer.toString('base64'), bersih)
          : await rapikanDeskripsi(bersih);
      } else {
        console.log('   ℹ️ Tidak ada foto yang cocok ditemukan di Drive.');
        deskripsi = await rapikanDeskripsi(bersih);
      }
      const judul = await ekstrakJudul(deskripsi);

      const data = loadData();
      data.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        tanggal,
        timestamp: Math.floor(Date.now()/1000),
        judul,
        deskripsi,
        foto: fotoCocok ? fotoCocok.directUrl : null,
        fotoDriveId: fotoCocok ? fotoCocok.fileId : null,
        sumber: 'wa_teks',
      });
      saveData(data);

      let balasan = `✅ Kegiatan "${judul}" (${tanggal}) berhasil dicatat!`;
      balasan += fotoCocok
        ? `\n📷 Foto otomatis dipasangkan dari folder Drive.`
        : `\n📷 Belum ada foto yang cocok — upload foto ke folder Drive lalu kirim ulang kegiatannya jika perlu.`;
      await kirimBalasanWA(sender, balasan);
      console.log(`   ✅ Disimpan: "${judul}"${fotoCocok ? ' (dengan foto)' : ''}`);
    }

  } catch (err) {
    console.error('❌ Error proses webhook:', err.message);
  }
});

// ── SINKRONISASI: ambil berita kegiatan dari mitrawacana.or.id ───────────
// Strategi: coba WordPress REST API dulu (lebih akurat & stabil — dapat tanggal ISO
// pasti, judul, isi, featured image langsung dalam JSON). Kalau ternyata REST API
// ditutup di server (banyak situs WP mematikannya untuk keamanan), baru jatuh ke
// scraping HTML halaman kategori "Berita" sebagai cadangan.

function stripHtml(html = '') {
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function cariIdKategoriWP(slug) {
  const url = `${WEBSITE_BASE_URL}/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}`;
  const res = await axios.get(url, { timeout: 15000 });
  const kat = (res.data || [])[0];
  if (!kat) throw new Error(`Kategori "${slug}" tidak ditemukan via REST API`);
  return kat.id;
}

// Ambil semua post WP dalam rentang tanggal [dariISO, sampaiISO], lewati pagination otomatis.
async function ambilBeritaViaRestApi(dariISO, sampaiISO) {
  const katId = await cariIdKategoriWP(WEBSITE_KATEGORI_SLUG);
  const hasil = [];
  let page = 1;
  const perPage = 50;
  while (true) {
    const url = `${WEBSITE_BASE_URL}/wp-json/wp/v2/posts`;
    const res = await axios.get(url, {
      timeout: 20000,
      params: {
        categories: katId,
        per_page: perPage,
        page,
        after: `${dariISO}T00:00:00`,
        before: `${sampaiISO}T23:59:59`,
        _embed: 1,
        orderby: 'date',
        order: 'asc',
      },
      validateStatus: s => s < 500,
    });
    if (res.status !== 200 || !Array.isArray(res.data) || res.data.length === 0) break;

    for (const post of res.data) {
      let fotoUrl = null;
      try {
        const media = post._embedded?.['wp:featuredmedia']?.[0];
        fotoUrl = media?.source_url || null;
      } catch {}
      hasil.push({
        judulAsli: stripHtml(post.title?.rendered || ''),
        isiAsli: stripHtml(post.content?.rendered || post.excerpt?.rendered || ''),
        tanggalISO: (post.date || '').slice(0, 10),
        sumberUrl: post.link,
        fotoUrl,
      });
    }
    const totalPages = parseInt(res.headers['x-wp-totalpages'] || '1', 10);
    if (page >= totalPages) break;
    page++;
  }
  return hasil;
}

// Cadangan: scraping HTML halaman kategori kalau REST API tidak tersedia.
async function ambilBeritaViaScraping(dariISO, sampaiISO) {
  const cheerio = require('cheerio');
  const dari = new Date(dariISO);
  const sampai = new Date(sampaiISO);
  const hasil = [];
  let halaman = 1;
  let lanjut = true;

  while (lanjut && halaman <= 60) { // batas wajar supaya tidak loop tanpa henti
    const url = halaman === 1
      ? `${WEBSITE_BASE_URL}/category/${WEBSITE_KATEGORI_SLUG}/`
      : `${WEBSITE_BASE_URL}/category/${WEBSITE_KATEGORI_SLUG}/page/${halaman}/`;
    let html;
    try {
      const res = await axios.get(url, { timeout: 20000 });
      html = res.data;
    } catch { break; }

    const $ = cheerio.load(html);
    const linkArtikel = new Set();
    $('a[href*="' + WEBSITE_BASE_URL.replace('https://', '') + '"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/\/category\//.test(href) || /\/page\//.test(href)) return;
      if (href === WEBSITE_BASE_URL || href === `${WEBSITE_BASE_URL}/`) return;
      linkArtikel.add(href.split('#')[0]);
    });

    if (linkArtikel.size === 0) { lanjut = false; break; }

    for (const link of linkArtikel) {
      try {
        const artikelRes = await axios.get(link, { timeout: 20000 });
        const $$ = cheerio.load(artikelRes.data);
        const judulAsli = $$('meta[property="og:title"]').attr('content') || $$('h1').first().text().trim();
        const tanggalMeta = $$('meta[property="article:published_time"]').attr('content')
          || $$('time').attr('datetime') || '';
        const tanggalISO = tanggalMeta ? tanggalMeta.slice(0, 10) : null;
        $$('script,style,nav,header,footer,.comments,#comments').remove();
        const isiAsli = stripHtml($$('.entry-content, article, .post-content').first().html() || $$('body').html() || '').slice(0, 4000);
        const fotoUrl = $$('meta[property="og:image"]').attr('content') || null;

        if (!tanggalISO) continue; // tanpa tanggal pasti, lewati biar tidak salah masuk rentang
        const tgl = new Date(tanggalISO);
        if (tgl < dari || tgl > sampai) continue;

        hasil.push({ judulAsli, isiAsli, tanggalISO, sumberUrl: link, fotoUrl });
      } catch { /* lewati artikel yang gagal diambil */ }
    }

    // Hentikan kalau artikel di halaman ini sudah lebih tua dari rentang yang dicari
    const adaYangMasihDalamRentang = hasil.some(h => new Date(h.tanggalISO) >= dari);
    if (!adaYangMasihDalamRentang && hasil.length > 0) lanjut = false;
    halaman++;
  }
  return hasil;
}

async function ambilBeritaWebsite(dariISO, sampaiISO) {
  try {
    const hasil = await ambilBeritaViaRestApi(dariISO, sampaiISO);
    console.log(`✅ Sinkron website via REST API: ${hasil.length} artikel ditemukan.`);
    return hasil;
  } catch (e) {
    console.warn(`⚠️  REST API website tidak tersedia (${e.message}), pakai scraping HTML sebagai cadangan...`);
    const hasil = await ambilBeritaViaScraping(dariISO, sampaiISO);
    console.log(`✅ Sinkron website via scraping: ${hasil.length} artikel ditemukan.`);
    return hasil;
  }
}

// Ubah 1 artikel mentah jadi format kegiatan e-magazine, unduh & simpan fotonya ke Drive.
async function prosesArtikelJadiKegiatan(artikel) {
  const [th, bl, hr] = artikel.tanggalISO.split('-').map(Number);
  const tanggalDate = new Date(th, bl - 1, hr);
  const tanggal = formatTanggal(tanggalDate);
  const timestamp = Math.floor(tanggalDate.getTime() / 1000);

  const deskripsi = await rapikanDeskripsi(artikel.isiAsli || artikel.judulAsli);
  const judul = artikel.judulAsli?.trim() || await ekstrakJudul(deskripsi);

  let driveResult = null;
  if (artikel.fotoUrl) {
    try {
      const imgRes = await axios.get(artikel.fotoUrl, { responseType: 'arraybuffer', timeout: 20000 });
      const mimeType = imgRes.headers['content-type'] || 'image/jpeg';
      const ext = mimeType.split('/')[1]?.split(';')[0] || 'jpg';
      driveResult = await uploadKeDrive(Buffer.from(imgRes.data), `web_${Date.now()}.${ext}`, mimeType);
    } catch (e) {
      console.warn('⚠️  Gagal unduh foto artikel:', e.message);
    }
  }

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    tanggal,
    timestamp,
    judul,
    deskripsi,
    foto: driveResult ? driveResult.directUrl : null,
    fotoDriveId: driveResult ? driveResult.fileId : null,
    sumber: 'website',
    sumberUrl: artikel.sumberUrl,
  };
}

// ── ENDPOINT: trigger sinkronisasi dari website (dipanggil manual oleh admin) ──
app.post('/api/sync/website', async (req, res) => {
  try {
    const dariISO   = req.body?.dariISO   || '2026-01-01';
    const sampaiISO = req.body?.sampaiISO || '2026-06-30';
    console.log(`🔄 Mulai sinkron website periode ${dariISO} s/d ${sampaiISO}...`);

    const artikelList = await ambilBeritaWebsite(dariISO, sampaiISO);
    const data = loadData();
    const urlSudahAda = new Set(data.map(d => d.sumberUrl).filter(Boolean));

    let ditambah = 0, dilewati = 0;
    for (const artikel of artikelList) {
      if (urlSudahAda.has(artikel.sumberUrl)) { dilewati++; continue; } // sudah pernah disinkron, hindari dobel
      const kegiatanBaru = await prosesArtikelJadiKegiatan(artikel);
      data.push(kegiatanBaru);
      urlSudahAda.add(artikel.sumberUrl);
      ditambah++;
    }
    saveData(data);

    console.log(`✅ Sinkron selesai: ${ditambah} kegiatan baru ditambahkan, ${dilewati} dilewati (sudah ada).`);
    res.json({ ok: true, ditemukan: artikelList.length, ditambah, dilewati });
  } catch (e) {
    console.error('❌ Gagal sinkron website:', e.message);
    res.status(500).json({ error: 'Gagal sinkron dari website: ' + e.message });
  }
});

// ── API untuk web viewer ───────────────────────────────────
app.get('/api/kegiatan', (req, res) => {
  const bulan = req.query.bulan || '';
  let data = loadData();
  if (bulan) data = data.filter(d => d.tanggal && d.tanggal.toLowerCase().includes(bulan.toLowerCase()));
  data.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  res.json(data);
});

// ── Tambah kegiatan manual (kustom) — bisa untuk tanggal/bulan apa saja ──
app.post('/api/kegiatan', async (req, res) => {
  try {
    const { tanggalISO, judul, deskripsi, fotoBase64 } = req.body;
    if (!judul || !deskripsi) {
      return res.status(400).json({ error: 'Judul dan deskripsi wajib diisi' });
    }

    // tanggalISO datang dari <input type="date"> format "YYYY-MM-DD"
    let tanggalDate = new Date();
    if (tanggalISO) {
      const [th, bl, hr] = tanggalISO.split('-').map(Number);
      if (th && bl && hr) tanggalDate = new Date(th, bl - 1, hr);
    }
    const tanggal = formatTanggal(tanggalDate);
    const timestamp = Math.floor(tanggalDate.getTime() / 1000);

    let driveResult = null;
    if (fotoBase64) {
      const matches = fotoBase64.match(/^data:(image\/\w+);base64,(.+)$/);
      const mimeType = matches ? matches[1] : 'image/jpeg';
      const base64Data = matches ? matches[2] : fotoBase64;
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = mimeType.split('/')[1] || 'jpg';
      driveResult = await uploadKeDrive(buffer, `kegiatan_${Date.now()}.${ext}`, mimeType);
    }

    const data = loadData();
    data.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      tanggal,
      timestamp,
      judul,
      deskripsi,
      foto: driveResult ? driveResult.directUrl : null,
      fotoDriveId: driveResult ? driveResult.fileId : null,
      sumber: 'manual',
    });
    saveData(data);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Gagal tambah kegiatan manual:', e.message);
    res.status(500).json({ error: 'Gagal menambahkan kegiatan' });
  }
});

app.delete('/api/kegiatan/:id', async (req, res) => {
  try {
    let data = loadData();
    const item = data.find(d => d.id === req.params.id);
    if (item?.fotoDriveId) {
      const drive = getDrive();
      if (drive) await drive.files.delete({ fileId: item.fotoDriveId, supportsAllDrives: true }).catch(()=>{});
    }
    data = data.filter(d => d.id !== req.params.id);
    saveData(data);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Gagal hapus' }); }
});

app.put('/api/kegiatan/:id', (req, res) => {
  try {
    let data = loadData();
    const idx = data.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Tidak ditemukan' });

    const { tanggalISO, ...rest } = req.body;
    const updates = { ...rest };

    if (tanggalISO) {
      const [th, bl, hr] = tanggalISO.split('-').map(Number);
      if (th && bl && hr) {
        const tanggalDate = new Date(th, bl - 1, hr);
        updates.tanggal = formatTanggal(tanggalDate);
        updates.timestamp = Math.floor(tanggalDate.getTime() / 1000);
      }
    }

    data[idx] = { ...data[idx], ...updates };
    saveData(data);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Gagal update' }); }
});

// ── Carousel Instagram ─────────────────────────────────────
app.get('/api/carousel-info', (req, res) => {
  const bulan = req.query.bulan || '';
  let data = loadData();
  if (bulan) data = data.filter(d => d.tanggal && d.tanggal.toLowerCase().includes(bulan.toLowerCase()));
  const totalSlide = Math.ceil(data.length / KEGIATAN_PER_SLIDE);
  res.json({ totalKegiatan: data.length, totalSlide });
});

app.get('/api/carousel-slide', async (req, res) => {
  try {
    const bulan = req.query.bulan || '';
    const slideKe = parseInt(req.query.slide || '1', 10);
    let data = loadData();
    if (bulan) data = data.filter(d => d.tanggal && d.tanggal.toLowerCase().includes(bulan.toLowerCase()));
    data.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (!data.length) return res.status(404).send('Tidak ada kegiatan');

    const bulanLabel = data[0]?.tanggal?.split(' ').slice(1).join(' ') || bulan || '';
    const totalSlide = Math.ceil(data.length / KEGIATAN_PER_SLIDE);
    const items = data.slice((slideKe - 1) * KEGIATAN_PER_SLIDE, slideKe * KEGIATAN_PER_SLIDE);
    if (!items.length) return res.status(404).send('Slide tidak ditemukan');

    const sharp = require('sharp');
    const svg = await buatSlideSvg(items, slideKe, totalSlide, bulanLabel);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="carousel-slide-${slideKe}.png"`);
    res.send(png);
  } catch (e) {
    console.error('❌ Gagal buat slide carousel:', e.message);
    res.status(500).send('Gagal membuat gambar carousel');
  }
});

// ── Helper: gelapkan warna hex (pengganti color-mix yang tidak universal) ──
function darkenHex(hex, amount = 0.45) {
  try {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = Math.max(0, Math.round(parseInt(h.slice(0,2),16) * (1 - amount)));
    const g = Math.max(0, Math.round(parseInt(h.slice(2,4),16) * (1 - amount)));
    const b = Math.max(0, Math.round(parseInt(h.slice(4,6),16) * (1 - amount)));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  } catch { return '#5a1d38'; }
}

// ── Carousel Instagram: generate gambar PNG (1080x1080) per slide ─────────
const KEGIATAN_PER_SLIDE = 4; // 3-4 kegiatan tiap slide (otomatis 3 kalau sisa ganjil di slide terakhir)

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Pecah teks panjang jadi beberapa baris <tspan> agar muat di lebar tertentu (estimasi karakter, bukan ukur asli)
function wrapTextSvg(text, x, y, maxCharsPerLine, maxLines, lineHeight, opts = '') {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const w of words) {
    const test = current ? current + ' ' + w : w;
    if (test.length > maxCharsPerLine && current) { lines.push(current); current = w; }
    else current = test;
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last.length > maxCharsPerLine - 1) lines[maxLines - 1] = last.slice(0, maxCharsPerLine - 1).trim() + '…';
  }
  const tspans = lines.map((line, i) =>
    `<tspan x="${x}" y="${y + i * lineHeight}">${escapeXml(line)}</tspan>`
  ).join('');
  return `<text ${opts}>${tspans}</text>`;
}

async function ambilFotoBase64(item) {
  try {
    if (item.fotoDriveId) {
      const buf = await downloadDriveFile(item.fotoDriveId);
      if (buf) return `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
    if (item.foto) {
      const res = await axios.get(item.foto, { responseType: 'arraybuffer', timeout: 10000 });
      return `data:image/jpeg;base64,${Buffer.from(res.data).toString('base64')}`;
    }
  } catch (e) { console.error('⚠️  Gagal ambil foto untuk carousel:', e.message); }
  return null;
}

// Pecah teks jadi array baris (estimasi karakter) — dipakai untuk hitung tinggi konten sebelum digambar
function wrapToLines(text, maxCharsPerLine, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const w of words) {
    const test = current ? current + ' ' + w : w;
    if (test.length > maxCharsPerLine && current) { lines.push(current); current = w; }
    else current = test;
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last.length > maxCharsPerLine - 1) lines[maxLines - 1] = last.slice(0, maxCharsPerLine - 1).trim() + '…';
  }
  return lines;
}

function linesToTspans(lines, x, y, lineHeight) {
  return lines.map((line, i) => `<tspan x="${x}" y="${y + i * lineHeight}">${escapeXml(line)}</tspan>`).join('');
}

async function buatSlideSvg(items, slideKe, totalSlide, bulanLabel) {
  const W = 1080, H = 1080;
  const tcDark = darkenHex(TEMA_WARNA, 0.55);
  const cardTop = 300;
  const cardGap = 18;
  const cardH = Math.floor((H - cardTop - 90 - (items.length - 1) * cardGap) / items.length);
  // Foto dibesarkan: pakai hampir seluruh tinggi kartu, dengan batas atas agar tetap proporsional
  const fotoSize = Math.min(cardH - 24, 420);

  const fotoData = await Promise.all(items.map(ambilFotoBase64));

  // Lebar teks menyesuaikan ukuran foto (foto lebih besar → teks lebih sempit)
  const fotoX = 56;
  const textX = fotoX + fotoSize + 32;
  const textAvailPx = (W - 40) - textX - 24;
  const textMaxChars = Math.max(18, Math.round(textAvailPx / 17.5));

  let cardsSvg = '';
  items.forEach((item, i) => {
    const y = cardTop + i * (cardH + cardGap);
    const foto = fotoData[i];
    const fotoY = y + (cardH - fotoSize) / 2;

    const judulLines = wrapToLines(item.judul || 'Tanpa Judul', textMaxChars, 2);
    const judulLineH = 30;
    // Deskripsi bisa beberapa baris, dibatasi oleh tinggi kartu yang tersedia
    const maxDeskLines = Math.max(2, Math.min(6, Math.floor((cardH - 40 - 26 - judulLines.length * judulLineH - 24) / 22)));
    const deskLines = wrapToLines(item.deskripsi || '', textMaxChars, maxDeskLines);
    const deskLineH = 22;

    // Tinggi total blok teks (tanggal + judul + jarak + deskripsi), untuk dipusatkan vertikal dalam kartu
    const blokTinggi = 26 + 14 + judulLines.length * judulLineH + 14 + deskLines.length * deskLineH;
    const blokY = y + Math.max(20, (cardH - blokTinggi) / 2);

    const tanggalY = blokY + 18;
    const judulY = tanggalY + 14 + 22;
    const deskY = judulY + (judulLines.length - 1) * judulLineH + 14 + 18;

    cardsSvg += `
    <rect x="40" y="${y}" width="${W - 80}" height="${cardH}" rx="20" fill="rgba(255,255,255,0.12)"/>
    ${foto
      ? `<clipPath id="clip${i}"><rect x="${fotoX}" y="${fotoY}" width="${fotoSize}" height="${fotoSize}" rx="16"/></clipPath>
         <image href="${foto}" x="${fotoX}" y="${fotoY}" width="${fotoSize}" height="${fotoSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip${i})"/>`
      : `<rect x="${fotoX}" y="${fotoY}" width="${fotoSize}" height="${fotoSize}" rx="16" fill="rgba(255,255,255,0.18)"/>
         <text x="${fotoX + fotoSize/2}" y="${fotoY + fotoSize/2 + 16}" font-size="48" text-anchor="middle">📷</text>`
    }
    <text x="${textX}" y="${tanggalY}" font-family="Nunito, sans-serif" font-size="22" font-weight="800" fill="#f5c842">${escapeXml(item.tanggal || '')}</text>
    <text font-family="Nunito, sans-serif" font-size="26" font-weight="800" fill="white">${linesToTspans(judulLines, textX, judulY, judulLineH)}</text>
    <text font-family="Nunito, sans-serif" font-size="18" fill="rgba(255,255,255,0.85)">${linesToTspans(deskLines, textX, deskY, deskLineH)}</text>
    `;
  });

  // Logo organisasi di pojok kanan atas
  const logoW = 150;
  const logoH = Math.round(logoW * (689 / 1189));
  const logoX = W - 56 - logoW;
  const logoY = 40;
  const logoSvg = LOGO_BASE64
    ? `<image href="${LOGO_BASE64}" x="${logoX}" y="${logoY}" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet"/>`
    : '';

  const svg = `
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${TEMA_WARNA}"/>
        <stop offset="100%" stop-color="${tcDark}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <text x="56" y="90" font-family="Nunito, sans-serif" font-size="30" font-weight="900" fill="white" letter-spacing="2">ON THE MONTH</text>
    <rect x="56" y="108" width="64" height="8" rx="4" fill="#f5c842"/>
    <text x="56" y="190" font-family="Nunito, sans-serif" font-size="64" font-weight="900" fill="#f5c842">${escapeXml(bulanLabel.toUpperCase())}</text>
    ${logoSvg}
    ${totalSlide > 1 && !LOGO_BASE64 ? `<text x="${W - 56}" y="90" font-family="Nunito, sans-serif" font-size="26" font-weight="800" fill="rgba(255,255,255,0.7)" text-anchor="end">${slideKe}/${totalSlide}</text>` : ''}
    ${totalSlide > 1 && LOGO_BASE64 ? `<text x="${W - 56}" y="${logoY + logoH + 26}" font-family="Nunito, sans-serif" font-size="22" font-weight="800" fill="rgba(255,255,255,0.7)" text-anchor="end">${slideKe}/${totalSlide}</text>` : ''}
    ${cardsSvg}
    <text x="${W/2}" y="${H - 36}" font-family="Nunito, sans-serif" font-size="22" font-weight="700" fill="white" text-anchor="middle">${escapeXml(ORG_NAMA)} · ${escapeXml(FOOTER_SOCMED)}</text>
  </svg>`;

  return svg;
}

async function buatGambarCarousel(bulan) {
  const sharp = require('sharp');
  let data = loadData();
  if (bulan) data = data.filter(d => d.tanggal && d.tanggal.toLowerCase().includes(bulan.toLowerCase()));
  data.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (!data.length) return [];

  const bulanLabel = data[0]?.tanggal?.split(' ').slice(1).join(' ') || bulan || '';
  const totalSlide = Math.ceil(data.length / KEGIATAN_PER_SLIDE);
  const hasil = [];

  for (let i = 0; i < totalSlide; i++) {
    const items = data.slice(i * KEGIATAN_PER_SLIDE, (i + 1) * KEGIATAN_PER_SLIDE);
    const svg = await buatSlideSvg(items, i + 1, totalSlide, bulanLabel);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    hasil.push(png);
  }
  return hasil;
}

// ── Halaman utama: E-Magazine Viewer ─────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>E-Magazine – ${ORG_NAMA}</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&family=Fredoka+One&display=swap" rel="stylesheet">
<style>
:root { --tc: ${TEMA_WARNA}; --tc-dark: ${darkenHex(TEMA_WARNA)}; --yellow: #f5c842; --dark: #2d1a2e; }
* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
@media print {
  html, body { background: linear-gradient(160deg, var(--tc) 0%, var(--tc-dark) 100%) !important; }
  .topbar, .modal-bg, .lightbox-bg { display: none !important; }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { font-family: 'Nunito', sans-serif; background: linear-gradient(160deg, var(--tc) 0%, var(--tc-dark) 100%) fixed; background-color: var(--tc); min-height: 100vh; }
.topbar { background: rgba(0,0,0,0.2); padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 99; }
.topbar h1 { font-family: 'Fredoka One', cursive; color: white; font-size: 1.2rem; display:flex; align-items:center; gap:10px; }
.topbar-logo { height: 32px; width: auto; border-radius: 6px; background: white; padding: 2px 6px; }
.cover { padding: 32px 20px 20px; position: relative; }
.cover-logo { position: absolute; top: 24px; right: 20px; height: 56px; width: auto; background: white; border-radius: 10px; padding: 6px 10px; box-shadow: 0 4px 14px rgba(0,0,0,0.25); }
.topbar input { padding: 7px 12px; border-radius: 8px; border: none; font-family:'Nunito',sans-serif; font-size: 0.88rem; background: rgba(255,255,255,0.18); color: white; outline: none; }
.topbar input::placeholder { color: rgba(255,255,255,0.85); opacity: 1; }
.btn-gen { padding: 8px 18px; background: var(--yellow); color: var(--dark); border: none; border-radius: 10px; font-weight: 800; font-size: 0.9rem; cursor: pointer; display:inline-flex; align-items:center; gap:7px; }
.btn-icon { width: 16px; height: 16px; flex-shrink: 0; }
.mag-wrap { max-width: 820px; margin: 0 auto; padding: 0 16px 60px; }
.cover-title { font-family:'Fredoka One',cursive; color:white; font-size:clamp(1.6rem,4vw,2.6rem); }
.cover-month { font-family:'Fredoka One',cursive; color:var(--yellow); font-size:clamp(3rem,10vw,5.5rem); line-height:1; }
.timeline { position: relative; padding: 0 8px; }
.timeline::before { content:''; position:absolute; left:40px; top:0; bottom:0; width:3px; background:rgba(255,255,255,0.35); border-radius:2px; }
.tl-item { display:flex; gap:14px; margin-bottom:28px; align-items:flex-start; position:relative; }
.bubble { width:64px; height:64px; border-radius:50%; background:var(--yellow); display:flex; flex-direction:column; align-items:center; justify-content:center; flex-shrink:0; z-index:2; }
.bubble .day { font-family:'Fredoka One',cursive; font-size:1.5rem; color:var(--dark); line-height:1; }
.bubble .myr { font-size:0.55rem; font-weight:700; color:var(--dark); opacity:.75; text-transform:uppercase; text-align:center; }
.card { flex:1; background:rgba(255,255,255,0.18); backdrop-filter:blur(6px); border-radius:16px; padding:14px; display:flex; gap:12px; align-items:flex-start; border:1px solid rgba(255,255,255,0.3); }
.card img { width:160px; height:160px; border-radius:10px; object-fit:cover; flex-shrink:0; cursor:pointer; transition:opacity .2s; }
.card img:hover { opacity:0.85; }
.card-nofoto { width:160px; height:160px; border-radius:10px; background:rgba(255,255,255,0.2); flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:2rem; border:2px dashed rgba(255,255,255,0.4); }
.card-body { flex:1; }
.card-judul { font-weight:900; font-size:0.95rem; color:var(--yellow); margin-bottom:6px; }
.card-desc { font-size:0.82rem; color:rgba(255,255,255,0.9); line-height:1.6; }
.card-actions { margin-top:8px; display:flex; gap:6px; }
.btn-edit, .btn-del { padding:4px 10px; border-radius:6px; border:none; cursor:pointer; font-size:0.75rem; font-weight:700; display:inline-flex; align-items:center; gap:5px; }
.btn-edit { background:rgba(255,255,255,0.2); color:white; }
.btn-del { background:rgba(255,100,100,0.35); color:white; }
.footer-bar { background:var(--yellow); border-radius:14px; padding:12px 20px; text-align:center; font-weight:700; color:var(--dark); margin-top:28px; font-size:0.88rem; }
.empty, .loading { text-align:center; color:rgba(255,255,255,0.65); padding:60px 20px; }
.modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:200; align-items:center; justify-content:center; }
.modal-bg.open { display:flex; }
.modal { background:white; border-radius:16px; padding:24px; max-width:480px; width:90%; }
.modal h3 { font-weight:800; margin-bottom:14px; color:var(--tc); }
.modal label { font-size:0.82rem; font-weight:700; color:#555; display:block; margin-bottom:3px; }
.modal input, .modal textarea { width:100%; padding:9px 12px; border:1.5px solid #ddd; border-radius:8px; font-size:0.9rem; margin-bottom:12px; }
.modal textarea { min-height:100px; }
.modal-btns { display:flex; gap:10px; justify-content:flex-end; }
.btn-save { padding:9px 20px; background:var(--tc); color:white; border:none; border-radius:8px; font-weight:800; cursor:pointer; display:inline-flex; align-items:center; gap:7px; }
.btn-cancel { padding:9px 16px; background:#eee; color:#333; border:none; border-radius:8px; font-weight:800; cursor:pointer; }
@media(max-width:520px){ .card { flex-direction:column; } .card img, .card-nofoto { width:100%; height:200px; } }
.lightbox-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:300; align-items:center; justify-content:center; padding:20px; cursor:zoom-out; }
.lightbox-bg.open { display:flex; }
.lightbox-bg img { max-width:100%; max-height:90vh; border-radius:10px; box-shadow:0 10px 40px rgba(0,0,0,0.5); }
.lightbox-close { position:absolute; top:18px; right:24px; color:white; font-size:2rem; cursor:pointer; line-height:1; background:rgba(255,255,255,0.15); width:40px; height:40px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
</style>
</head>
<body>
<div class="topbar">
  <h1><img src="${LOGO_URL_PUBLIK}" alt="${ORG_NAMA}" class="topbar-logo"> E-Magazine</h1>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <input type="text" id="filter-bulan" placeholder="Filter bulan (mis: Juli 2025)" onchange="loadData()">
    <button class="btn-gen" onclick="openAddModal()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Tambah Kegiatan</button>
    <button class="btn-gen" onclick="window.print()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print / PDF</button>
    <button class="btn-gen" onclick="buatCarousel()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Buat Carousel IG</button>
    <button class="btn-gen" id="sync-website-btn" onclick="syncWebsite()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg> Sync dari Website</button>
  </div>
</div>
<div class="modal-bg" id="carousel-modal">
  <div class="modal">
    <h3>Carousel Instagram</h3>
    <p id="carousel-info" style="color:#444;margin:10px 0;">Menyiapkan slide...</p>
    <div id="carousel-list" style="display:flex;flex-direction:column;gap:8px;max-height:300px;overflow-y:auto;"></div>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeCarouselModal()">Tutup</button>
    </div>
  </div>
</div>
<div class="mag-wrap">
  <div class="cover">
    <img src="${LOGO_URL_PUBLIK}" alt="${ORG_NAMA}" class="cover-logo">
    <div class="cover-title">ON THE MONTH</div>
    <div class="cover-month" id="cover-month">—</div>
  </div>
  <div class="timeline" id="timeline"><div class="loading">⏳ Memuat...</div></div>
  <div class="footer-bar">${ORG_NAMA} · ${FOOTER_SOCMED}</div>
</div>
<div class="modal-bg" id="add-modal">
  <div class="modal">
    <h3>Tambah Kegiatan</h3>
    <label>Tanggal</label><input type="date" id="add-tanggal">
    <label>Judul</label><input type="text" id="add-judul" placeholder="Judul kegiatan">
    <label>Deskripsi</label><textarea id="add-desc" placeholder="Deskripsi kegiatan"></textarea>
    <label>Foto (opsional)</label><input type="file" id="add-foto" accept="image/*">
    <div id="add-foto-preview" style="margin:6px 0 12px;"></div>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeAddModal()">Batal</button>
      <button class="btn-save" id="add-save-btn" onclick="simpanTambah()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Simpan</button>
    </div>
  </div>
</div>
<div class="modal-bg" id="modal">
  <div class="modal">
    <h3>Edit Kegiatan</h3>
    <input type="hidden" id="edit-id">
    <label>Tanggal</label><input type="date" id="edit-tanggal">
    <label>Judul</label><input type="text" id="edit-judul">
    <label>Deskripsi</label><textarea id="edit-desc"></textarea>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeModal()">Batal</button>
      <button class="btn-save" onclick="saveEdit()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Simpan</button>
    </div>
  </div>
</div>
<div class="lightbox-bg" id="lightbox" onclick="closeLightbox()">
  <div class="lightbox-close" onclick="closeLightbox()">✕</div>
  <img id="lightbox-img" src="" alt="Foto kegiatan">
</div>
<script>
let allData = [];
async function loadData() {
  const bulan = document.getElementById('filter-bulan').value;
  const url = '/api/kegiatan' + (bulan ? '?bulan=' + encodeURIComponent(bulan) : '');
  const tl = document.getElementById('timeline');
  tl.innerHTML = '<div class="loading">⏳ Memuat...</div>';
  try {
    const r = await fetch(url);
    allData = await r.json();
    renderTimeline();
  } catch { tl.innerHTML = '<div class="empty">Gagal memuat data</div>'; }
}
function renderTimeline() {
  const tl = document.getElementById('timeline');
  if (!allData.length) { tl.innerHTML = '<div class="empty">📭 Belum ada kegiatan.<br><br>Kirim foto/teks #kegiatan ke grup WA</div>'; return; }
  const bulan = allData[0]?.tanggal?.split(' ').slice(1).join(' ') || '';
  document.getElementById('cover-month').textContent = bulan.toUpperCase();
  tl.innerHTML = allData.map(item => {
    const dayMatch = item.tanggal?.match(/^(\\d+)/);
    const day = dayMatch ? dayMatch[1] : '?';
    const monthYr = item.tanggal?.replace(/^\\d+\\s*/, '') || '';
    const fotoUrl = (item.foto || '').replace(/'/g, '&#39;');
    const fotoHTML = item.foto ? '<img src="'+fotoUrl+'" loading="lazy" onclick="openLightbox(\\''+fotoUrl+'\\')" onerror="this.outerHTML=\\'<div class=&quot;card-nofoto&quot;>📷</div>\\'">' : '<div class="card-nofoto">📷</div>';
    return '<div class="tl-item"><div class="bubble"><span class="day">'+day+'</span><span class="myr">'+monthYr+'</span></div><div class="card">'+fotoHTML+'<div class="card-body"><div class="card-judul">"'+(item.judul||'Tanpa Judul')+'"</div><div class="card-desc">'+(item.deskripsi||'')+'</div><div class="card-actions"><button class="btn-edit" onclick="openEdit(\\''+item.id+'\\')"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit</button><button class="btn-del" onclick="hapus(\\''+item.id+'\\')"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Hapus</button></div></div></div></div>';
  }).join('');
}
const NAMA_BULAN_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function tanggalIdKeISO(tanggalStr) {
  // "30 Juni 2026" -> "2026-06-30"
  if (!tanggalStr) return '';
  const parts = tanggalStr.trim().split(/\s+/);
  if (parts.length < 3) return '';
  const hari = parseInt(parts[0], 10);
  const bulanIdx = NAMA_BULAN_ID.findIndex(b => b.toLowerCase() === parts[1].toLowerCase());
  const tahun = parseInt(parts[2], 10);
  if (!hari || bulanIdx === -1 || !tahun) return '';
  const mm = String(bulanIdx + 1).padStart(2, '0');
  const dd = String(hari).padStart(2, '0');
  return tahun + '-' + mm + '-' + dd;
}
function openEdit(id) {
  const item = allData.find(d => d.id === id);
  if (!item) return;
  document.getElementById('edit-id').value = id;
  document.getElementById('edit-tanggal').value = tanggalIdKeISO(item.tanggal);
  document.getElementById('edit-judul').value = item.judul || '';
  document.getElementById('edit-desc').value = item.deskripsi || '';
  document.getElementById('modal').classList.add('open');
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }
function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }

let addFotoBase64 = null;
function openAddModal() {
  document.getElementById('add-tanggal').value = new Date().toISOString().slice(0,10);
  document.getElementById('add-judul').value = '';
  document.getElementById('add-desc').value = '';
  document.getElementById('add-foto').value = '';
  document.getElementById('add-foto-preview').innerHTML = '';
  addFotoBase64 = null;
  document.getElementById('add-modal').classList.add('open');
}
function closeAddModal() { document.getElementById('add-modal').classList.remove('open'); }
document.getElementById('add-foto').addEventListener('change', function(e) {
  const file = e.target.files[0];
  const preview = document.getElementById('add-foto-preview');
  if (!file) { addFotoBase64 = null; preview.innerHTML = ''; return; }
  const reader = new FileReader();
  reader.onload = function() {
    addFotoBase64 = reader.result;
    preview.innerHTML = '<img src="' + addFotoBase64 + '" style="max-width:120px;max-height:120px;border-radius:8px;">';
  };
  reader.readAsDataURL(file);
});
async function simpanTambah() {
  const tanggalISO = document.getElementById('add-tanggal').value;
  const judul = document.getElementById('add-judul').value.trim();
  const deskripsi = document.getElementById('add-desc').value.trim();
  if (!judul || !deskripsi) { alert('Judul dan deskripsi wajib diisi'); return; }
  const btn = document.getElementById('add-save-btn');
  const btnHtmlAsli = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    const r = await fetch('/api/kegiatan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tanggalISO, judul, deskripsi, fotoBase64: addFotoBase64 })
    });
    if (!r.ok) throw new Error('gagal');
    closeAddModal();
    loadData();
  } catch (e) {
    alert('Gagal menyimpan kegiatan');
  } finally {
    btn.disabled = false; btn.innerHTML = btnHtmlAsli;
  }
}

async function buatCarousel() {
  const bulan = document.getElementById('filter-bulan').value;
  const modal = document.getElementById('carousel-modal');
  const info = document.getElementById('carousel-info');
  const list = document.getElementById('carousel-list');
  list.innerHTML = '';
  info.textContent = 'Menyiapkan slide...';
  modal.classList.add('open');
  try {
    const r = await fetch('/api/carousel-info' + (bulan ? '?bulan=' + encodeURIComponent(bulan) : ''));
    const d = await r.json();
    if (!d.totalSlide) { info.textContent = 'Tidak ada kegiatan untuk dibuatkan carousel.'; return; }
    info.textContent = d.totalKegiatan + ' kegiatan → ' + d.totalSlide + ' slide. Klik untuk download tiap slide:';
    for (let i = 1; i <= d.totalSlide; i++) {
      const url = '/api/carousel-slide?slide=' + i + (bulan ? '&bulan=' + encodeURIComponent(bulan) : '');
      const a = document.createElement('a');
      a.href = url; a.download = 'carousel-slide-' + i + '.png';
      a.className = 'btn-gen'; a.style.justifyContent = 'center';
      a.innerHTML = '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download Slide ' + i + ' / ' + d.totalSlide;
      list.appendChild(a);
    }
  } catch (e) { info.textContent = 'Gagal menyiapkan carousel.'; }
}
function closeCarouselModal() { document.getElementById('carousel-modal').classList.remove('open'); }

async function syncWebsite() {
  const dariISO = prompt('Sinkron berita dari tanggal (YYYY-MM-DD):', '2026-01-01');
  if (!dariISO) return;
  const sampaiISO = prompt('Sampai tanggal (YYYY-MM-DD):', '2026-06-30');
  if (!sampaiISO) return;
  const btn = document.getElementById('sync-website-btn');
  const asli = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Menyinkron...';
  try {
    const r = await fetch('/api/sync/website', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dariISO, sampaiISO })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Gagal sinkron');
    alert('Sinkron selesai!\\nDitemukan: ' + d.ditemukan + ' artikel\\nDitambahkan: ' + d.ditambah + ' kegiatan baru\\nDilewati (sudah ada): ' + d.dilewati);
    loadData();
  } catch (e) {
    alert('Gagal sinkron dari website: ' + e.message);
  } finally {
    btn.disabled = false; btn.innerHTML = asli;
  }
}

async function saveEdit() {
  const id = document.getElementById('edit-id').value;
  const judul = document.getElementById('edit-judul').value;
  const deskripsi = document.getElementById('edit-desc').value;
  const tanggalISO = document.getElementById('edit-tanggal').value;
  await fetch('/api/kegiatan/' + id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({judul, deskripsi, tanggalISO}) });
  closeModal(); loadData();
}
async function hapus(id) {
  if (!confirm('Hapus kegiatan ini?')) return;
  await fetch('/api/kegiatan/' + id, { method:'DELETE' });
  loadData();
}
loadData();
setInterval(loadData, 30000);
</script>
</body>
</html>`);
});

Promise.all([restoreDataDariDrive(), muatLogo()]).finally(() => {
  app.listen(PORT, () => {
    console.log(`🌐 Server aktif di port ${PORT}`);
    console.log(`📲 Webhook URL untuk Fonnte: https://<domain-kamu>/webhook/fonnte`);
  });
});
