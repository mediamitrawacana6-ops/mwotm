const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const {
  Document: DocxDocument, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, HeadingLevel, VerticalAlign,
} = require('docx');

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
// OAuth2 delegation ke akun Gmail pribadi (BUKAN service account).
// Service account tidak bisa dipakai untuk upload karena tidak punya storage quota
// sendiri, dan Shared Drive tidak tersedia untuk akun Gmail biasa (bukan Workspace).
// Ketiga nilai ini didapat dari proses satu-kali di get-refresh-token.js.
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';
const WEBSITE_BASE_URL = process.env.WEBSITE_BASE_URL || 'https://mitrawacana.or.id'; // sumber sinkronisasi berita kegiatan
const WEBSITE_KATEGORI_SLUG = process.env.WEBSITE_KATEGORI_SLUG || 'berita'; // hanya ambil dari kategori ini

// Folder Drive berisi jurnal harian (Google Docs/teks) — default diambil dari folder
// yang dibagikan: https://drive.google.com/drive/folders/1wKxO-dVPZaDhEPWu5PMnggpXcugEtAR1
// Folder ini WAJIB sudah di-share (minimal "Viewer") ke akun Gmail yang dipakai untuk
// OAuth2 (GOOGLE_REFRESH_TOKEN), sama seperti folder foto GDRIVE_FOLDER_ID.
const JURNAL_FOLDER_ID = process.env.JURNAL_FOLDER_ID || '1wKxO-dVPZaDhEPWu5PMnggpXcugEtAR1';

// Google Calendar untuk sinkronisasi jadwal kegiatan — default dari kalender yang dibagikan:
// https://calendar.google.com/calendar/u/0/newembed?...&src=mediamitrawacana6@gmail.com
// Kalender ini WAJIB sudah di-share ke akun Gmail yang dipakai untuk OAuth2 dengan izin
// minimal "Lihat semua detail acara", DAN token OAuth2 (GOOGLE_REFRESH_TOKEN) harus dibuat
// dengan scope tambahan "https://www.googleapis.com/auth/calendar.readonly" (selain scope
// Drive yang sudah ada) — lihat get-refresh-token.js, tambahkan scope ini lalu generate ulang.
const CALENDAR_ID = process.env.CALENDAR_ID || 'mediamitrawacana6@gmail.com';

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
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.warn('⚠️  GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN belum diisi — fitur foto tidak akan berfungsi.');
    return null;
  }
  try {
    // OAuth2 sebagai akun Gmail pribadi (pemilik folder), bukan service account.
    // Service account tidak punya storage quota sendiri, jadi upload file baru
    // selalu gagal dengan error "Service Accounts do not have storage quota"
    // walau folder sudah di-share sebagai Editor ke service account.
    // Dengan OAuth2 delegation, upload dilakukan atas nama akun asli sehingga
    // memakai kuota penyimpanan akun itu sendiri.
    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    driveClient = google.drive({ version: 'v3', auth: oauth2Client });
    return driveClient;
  } catch (e) {
    console.error('❌ Gagal setup OAuth2 Google Drive:', e.message);
    return null;
  }
}

// ── Google Calendar setup (pakai OAuth2 yang sama dengan Drive) ──
let calendarClient = null;
function getCalendar() {
  if (calendarClient) return calendarClient;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.warn('⚠️  GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN belum diisi — sync kalender tidak akan berfungsi.');
    return null;
  }
  try {
    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
    return calendarClient;
  } catch (e) {
    console.error('❌ Gagal setup OAuth2 Google Calendar:', e.message);
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
const NAMA_BULAN_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function formatTanggal(date = new Date()) {
  return `${date.getDate()} ${NAMA_BULAN_ID[date.getMonth()]} ${date.getFullYear()}`;
}
// Cari tanggal yang disebutkan di dalam teks bebas (caption WA / deskripsi hasil AI),
// misal "Pada 28 Juni, ..." atau "5 hingga 7 Juni 2026" -> ambil tanggal pertama yang disebut.
// Kalau tahun tidak disebut di teks, pakai tahun berjalan. Return null kalau tidak ketemu.
function cariTanggalDiTeksServer(teks) {
  if (!teks) return null;
  const namaBulanRegex = NAMA_BULAN_ID.join('|');
  const re = new RegExp('\\b(\\d{1,2})\\b(?:\\s*(?:[-–]|hingga|sampai)\\s*\\d{1,2}\\s*)?\\s+(' + namaBulanRegex + ')\\b(?:\\s+(\\d{4}))?', 'i');
  const m = teks.match(re);
  if (!m) return null;
  const hari = parseInt(m[1], 10);
  const bulanIdx = NAMA_BULAN_ID.findIndex(b => b.toLowerCase() === m[2].toLowerCase());
  const tahun = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  if (!hari || hari > 31 || bulanIdx === -1) return null;
  return new Date(tahun, bulanIdx, hari);
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

// ── AI: buat "Output", "Deskripsi Singkat" (1 paragraf), dan klasifikasi "Divisi" ──
// Dipecah per-batch (bukan 1 panggilan untuk semua kegiatan) supaya output JSON
// tidak terpotong saat jumlah kegiatan banyak — itu penyebab utama Output selalu "-"
// pada versi sebelumnya (batch tunggal + max_tokens tetap 4000 bisa membuat JSON
// terpotong sebelum kurung tutup, sehingga JSON.parse gagal dan SEMUA field, termasuk
// Output, jatuh ke fallback).
const DAFTAR_DIVISI = [
  'Divisi Keuangan',
  'Divisi Penelitian dan Advokasi',
  'Divisi Media & Pengelolaan Pengetahuan',
  'Divisi Pendidikan & Pengorganisasian Masyarakat',
  'Project Manager',
];

// ── Hashtag divisi untuk input WA ─────────────────────────
// Pengguna bisa menambahkan salah satu tagar berikut di pesan WA (bersamaan dengan
// #kegiatan / #rekap, atau di caption foto) untuk menentukan divisi secara manual,
// tanpa perlu menunggu klasifikasi otomatis oleh AI saat export DOCX.
// Contoh: "Pelatihan pencegahan TPPO di Kalidengen #kegiatan #pendidikan"
const DIVISI_HASHTAG_MAP = {
  keuangan: 'Divisi Keuangan',
  finance: 'Divisi Keuangan',
  penelitian: 'Divisi Penelitian dan Advokasi',
  riset: 'Divisi Penelitian dan Advokasi',
  advokasi: 'Divisi Penelitian dan Advokasi',
  media: 'Divisi Media & Pengelolaan Pengetahuan',
  pengetahuan: 'Divisi Media & Pengelolaan Pengetahuan',
  publikasi: 'Divisi Media & Pengelolaan Pengetahuan',
  pendidikan: 'Divisi Pendidikan & Pengorganisasian Masyarakat',
  pengorganisasian: 'Divisi Pendidikan & Pengorganisasian Masyarakat',
  masyarakat: 'Divisi Pendidikan & Pengorganisasian Masyarakat',
  projectmanager: 'Project Manager',
  pm: 'Project Manager',
  manajemenproyek: 'Project Manager',
  manajerproyek: 'Project Manager',
  proyek: 'Project Manager',
};

// Deteksi tagar divisi di dalam teks bebas, keluarkan tagar tsb dari teks, dan
// kembalikan nama divisi resminya (atau null kalau tidak ada tagar divisi yang cocok).
function deteksiDivisiDiTeksServer(teks) {
  if (!teks) return { divisi: null, teksBersih: teks };
  let divisiTerdeteksi = null;
  const teksBersih = teks
    .replace(/#(\w+)/g, (match, tag) => {
      const key = tag.toLowerCase();
      if (!divisiTerdeteksi && DIVISI_HASHTAG_MAP[key]) {
        divisiTerdeteksi = DIVISI_HASHTAG_MAP[key];
        return '';
      }
      return match; // biarkan tagar lain (mis. #kegiatan/#rekap) apa adanya, dibersihkan di tempat lain
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { divisi: divisiTerdeteksi, teksBersih };
}

const UKURAN_BATCH_HIGHLIGHT = 6; // jumlah kegiatan per panggilan AI — aman dari potongan JSON

async function buatHighlightUntukTabel(items) {
  // items: [{ judul, deskripsi }]  ->  [{ output, deskripsiSingkat, divisi }]
  const fallback = items.map(it => ({
    output: '-',
    deskripsiSingkat: (it.deskripsi || '').slice(0, 300),
    divisi: DAFTAR_DIVISI[3], // default paling umum kalau AI tidak tersedia
  }));
  if (!ANTHROPIC_KEY || !items.length) return fallback;

  const hasilAkhir = new Array(items.length);
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  for (let awal = 0; awal < items.length; awal += UKURAN_BATCH_HIGHLIGHT) {
    const batch = items.slice(awal, awal + UKURAN_BATCH_HIGHLIGHT);
    const batchFallback = fallback.slice(awal, awal + UKURAN_BATCH_HIGHLIGHT);

    try {
      const daftar = batch.map((it, i) => `${i + 1}. Judul: "${it.judul}"\nDeskripsi: "${(it.deskripsi || '').slice(0, 600)}"`).join('\n\n');
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(8000, 600 + batch.length * 400), // cukup lega per item, tidak akan terpotong
        messages: [{
          role: 'user',
          content: `Untuk setiap kegiatan organisasi berikut, buatkan tiga hal dalam Bahasa Indonesia:

1. "output": hasil/capaian konkret dari kegiatan itu, ditulis dalam SATU KALIMAT UTUH sekitar 12-20 kata (contoh: "50 remaja di Kalurahan Kalidengen teredukasi tentang bahaya perdagangan orang dan cara pencegahannya", "Tersusun MoU pendampingan korban antara Mitra Wacana dan Polsek Temon sebagai dasar kerja sama lanjutan"). Sertakan detail konkret sejauh tersedia di deskripsi — jumlah peserta, nama tempat/mitra, atau bentuk hasil nyata (dokumen, kesepakatan, keterampilan yang didapat, dsb) — jangan cuma frasa pendek generik. WAJIB DIISI dengan kalimat lengkap — jangan pernah kosong, jangan cuma "-", dan jangan disingkat jadi beberapa kata saja. Kalau deskripsi tidak menyebutkan hasil eksplisit, susun berdasarkan tujuan kegiatan tersebut tapi tetap dalam bentuk kalimat utuh yang informatif.

2. "deskripsiSingkat": ringkasan 1 paragraf utuh (2-3 kalimat mengalir, BUKAN poin-poin) yang merangkum inti kegiatan tersebut.

3. "divisi": klasifikasikan ke SATU divisi, pilih PERSIS salah satu (salin teksnya persis):
   - "Divisi Keuangan" — pendanaan, financial planning, laporan/audit keuangan, penggalangan dana.
   - "Divisi Penelitian dan Advokasi" — riset, kajian, advokasi kebijakan, audiensi DPRD/pemerintah, pemantauan regulasi.
   - "Divisi Media & Pengelolaan Pengetahuan" — publikasi, media, webinar, dokumentasi, pengelolaan pengetahuan/informasi, media sosial.
   - "Divisi Pendidikan & Pengorganisasian Masyarakat" — edukasi, sosialisasi, pelatihan masyarakat/komunitas, pendampingan lembaga/kelompok masyarakat, pengorganisasian warga.
   - "Project Manager" — perencanaan & koordinasi proyek lintas divisi, penyusunan timeline/RAB proyek, monitoring & evaluasi progres proyek, rapat koordinasi internal tim, pelaporan proyek ke funder/mitra.
   Kalau ambigu, pilih yang isi kegiatannya PALING dominan.

Daftar kegiatan:
${daftar}

Jawab HANYA dengan JSON array murni, TANPA markdown code block, TANPA teks pembuka/penutup apa pun. Jumlah entri HARUS SAMA PERSIS dengan jumlah kegiatan di atas (${batch.length} entri), urutan sesuai nomor, format:
[{"output": "...", "deskripsiSingkat": "...", "divisi": "..."}, ...]`
        }]
      });

      const teksMentah = resp.content[0].text.trim();
      // Ekstrak array JSON walau AI menambahkan teks/markdown di luar instruksi
      const cocokArray = teksMentah.match(/\[[\s\S]*\]/);
      const teksJson = cocokArray ? cocokArray[0] : teksMentah.replace(/^```json\s*|```\s*$/g, '').trim();
      const hasil = JSON.parse(teksJson);

      if (!Array.isArray(hasil) || hasil.length !== batch.length) {
        console.error(`⚠️  Highlight batch [${awal}-${awal + batch.length}]: jumlah entri tidak cocok (dapat ${Array.isArray(hasil) ? hasil.length : 'bukan array'}, harusnya ${batch.length}). Pakai fallback untuk batch ini.`);
        for (let i = 0; i < batch.length; i++) hasilAkhir[awal + i] = batchFallback[i];
        continue;
      }

      for (let i = 0; i < batch.length; i++) {
        const h = hasil[i] || {};
        hasilAkhir[awal + i] = {
          output: (h.output && String(h.output).trim()) || batchFallback[i].output,
          deskripsiSingkat: (h.deskripsiSingkat && String(h.deskripsiSingkat).trim()) || batchFallback[i].deskripsiSingkat,
          divisi: DAFTAR_DIVISI.includes(h.divisi) ? h.divisi : batchFallback[i].divisi,
        };
      }
    } catch (e) {
      // Log detail supaya kalau gagal lagi, penyebabnya kelihatan di log Render (bukan cuma "-" misterius)
      console.error(`❌ Gagal buat highlight batch [${awal}-${awal + batch.length}]:`, e.message);
      for (let i = 0; i < batch.length; i++) hasilAkhir[awal + i] = batchFallback[i];
    }
  }

  return hasilAkhir;
}

// ── DOCX: bangun tabel ringkasan (No | Tanggal | Output | Kegiatan | Deskripsi Singkat) ──
function buatTabelHighlightDocx(baris) {
  const warnaUtama = (TEMA_WARNA || '#a6174d').replace('#', '').toUpperCase();
  const warnaAbu = 'F2F2F2';
  const lebarKolom = [500, 1300, 2700, 1900, 3100]; // total 9500 DXA — Output diperlebar karena sekarang berupa kalimat utuh
  const lebarTabel = lebarKolom.reduce((a, b) => a + b, 0);

  const headerCell = (teks, width) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: warnaUtama },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text: teks, bold: true, color: 'FFFFFF', size: 21 })] })],
  });

  const bodyCell = (teks, width, shaded) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: shaded ? { type: ShadingType.CLEAR, fill: warnaAbu } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [new Paragraph({ children: [new TextRun({ text: teks || '-', size: 20 })] })],
  });

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      headerCell('No', lebarKolom[0]),
      headerCell('Tanggal', lebarKolom[1]),
      headerCell('Output', lebarKolom[2]),
      headerCell('Kegiatan', lebarKolom[3]),
      headerCell('Deskripsi Singkat', lebarKolom[4]),
    ],
  });

  const bodyRows = baris.map((item, i) => new TableRow({
    children: [
      bodyCell(String(item.no), lebarKolom[0], i % 2 === 1),
      bodyCell(item.tanggal, lebarKolom[1], i % 2 === 1),
      bodyCell(item.output, lebarKolom[2], i % 2 === 1),
      bodyCell(item.kegiatan, lebarKolom[3], i % 2 === 1),
      bodyCell(item.deskripsiSingkat, lebarKolom[4], i % 2 === 1),
    ],
  }));

  return new Table({
    width: { size: lebarTabel, type: WidthType.DXA },
    columnWidths: lebarKolom,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
    },
    rows: [headerRow, ...bodyRows],
  });
}

// ── DOCX: rakit dokumen ringkasan lengkap, dikelompokkan otomatis per divisi ──
async function buatDocxRingkasan(kegiatanTerpilih, labelPeriode) {
  const warnaUtama = (TEMA_WARNA || '#a6174d').replace('#', '').toUpperCase();
  const highlight = await buatHighlightUntukTabel(
    kegiatanTerpilih.map(k => ({ judul: k.judul, deskripsi: k.deskripsi }))
  );
  const baris = kegiatanTerpilih.map((k, i) => ({
    tanggal: k.tanggal || '-',
    output: highlight[i].output,
    kegiatan: k.judul || 'Tanpa Judul',
    deskripsiSingkat: highlight[i].deskripsiSingkat,
    // Kalau divisi sudah ditentukan manual (dari form web atau tagar WA), pakai itu —
    // AI hanya dipakai untuk mengisi kegiatan yang belum punya divisi eksplisit.
    divisi: (k.divisi && DAFTAR_DIVISI.includes(k.divisi)) ? k.divisi : highlight[i].divisi,
  }));

  // Kelompokkan per divisi mengikuti urutan tetap di DAFTAR_DIVISI; divisi yang
  // tidak dikenali (di luar daftar resmi) dikumpulkan di grup "Lainnya" di akhir.
  const grupPerDivisi = new Map();
  [...DAFTAR_DIVISI, 'Lainnya'].forEach(d => grupPerDivisi.set(d, []));
  baris.forEach(b => {
    const key = grupPerDivisi.has(b.divisi) ? b.divisi : 'Lainnya';
    grupPerDivisi.get(key).push(b);
  });

  const kontenDokumen = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `Ringkasan Kegiatan — ${ORG_NAMA}`, bold: true, color: warnaUtama, size: 32 })],
    }),
    new Paragraph({
      spacing: { after: 300 },
      children: [new TextRun({ text: labelPeriode, italics: true, size: 22, color: '555555' })],
    }),
  ];

  let nomorGlobal = 1;
  for (const [namaDivisi, itemDivisi] of grupPerDivisi) {
    if (!itemDivisi.length) continue; // lewati divisi yang tidak ada kegiatannya
    const barisBernomor = itemDivisi.map(item => ({ ...item, no: nomorGlobal++ }));
    kontenDokumen.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 300, after: 150 },
      children: [new TextRun({ text: `${namaDivisi} (${itemDivisi.length} kegiatan)`, bold: true, color: warnaUtama, size: 26 })],
    }));
    kontenDokumen.push(buatTabelHighlightDocx(barisBernomor));
  }

  const doc = new DocxDocument({
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // US Letter, DXA
          margin: { top: 1000, bottom: 1000, left: 900, right: 900 },
        },
      },
      children: kontenDokumen,
    }],
  });

  return Packer.toBuffer(doc);
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

    if (!mediaUrl && !pesanTeks) {
      console.log('   (dilewati — tidak ada teks maupun media di payload)');
      return;
    }

    // ── Pesan dengan FOTO langsung (hanya jika paket Fonnte mendukung) ──
    if (mediaUrl) {
      console.log('📸 Foto masuk dari grup...');
      const buffer = await downloadMediaFonnte(mediaUrl);
      if (!buffer) return;

      // Deteksi tagar divisi di caption foto (mis. "#pendidikan"), keluarkan dari
      // teks sebelum dipakai sebagai konteks pembuatan deskripsi AI.
      const { divisi: divisiTerdeteksi, teksBersih: captionBersih } = deteksiDivisiDiTeksServer(pesanTeks);

      const imageBase64 = buffer.toString('base64');
      const deskripsi    = await buatDeskripsi(imageBase64, captionBersih);
      const judul        = await ekstrakJudul(deskripsi);

      // Deteksi tanggal dari caption WA atau dari deskripsi hasil AI; kalau tidak
      // disebutkan sama sekali, pakai tanggal hari ini pesan diterima.
      const tanggalTerdeteksi = cariTanggalDiTeksServer(captionBersih) || cariTanggalDiTeksServer(deskripsi);
      const tanggalDate = tanggalTerdeteksi || new Date();
      const tanggal = formatTanggal(tanggalDate);
      const timestamp = Math.floor(tanggalDate.getTime() / 1000);

      const filename = `kegiatan_${Date.now()}.jpg`;
      const driveResult = await uploadKeDrive(buffer, filename);

      const data = loadData();
      data.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        tanggal,
        timestamp,
        judul,
        deskripsi,
        foto: driveResult ? driveResult.directUrl : null,
        fotoDriveId: driveResult ? driveResult.fileId : null,
        divisi: divisiTerdeteksi,
        sumber: 'wa_foto',
      });
      saveData(data);

      let balasan = `✅ Kegiatan "${judul}" (${tanggal}) berhasil disimpan untuk e-magazine!`;
      if (divisiTerdeteksi) balasan += `\n🏷️ Divisi: ${divisiTerdeteksi}`;
      await kirimBalasanWA(sender, balasan);
      console.log(`   ✅ Disimpan: "${judul}" (${tanggal})${divisiTerdeteksi ? ' [' + divisiTerdeteksi + ']' : ''}`);
    }

    // ── Pesan TEKS dengan hashtag — AI cari foto paling relevan dari Drive ──
    else if (pesanTeks && (pesanTeks.toLowerCase().includes('#kegiatan') || pesanTeks.toLowerCase().includes('#rekap'))) {
      console.log('📝 Teks kegiatan masuk...');

      // Deteksi tagar divisi (mis. "#pendidikan", "#advokasi") dan keluarkan dari teks
      // sebelum tagar #kegiatan/#rekap juga dibersihkan.
      const { divisi: divisiTerdeteksi, teksBersih: teksSetelahDivisi } = deteksiDivisiDiTeksServer(pesanTeks);
      const bersih = teksSetelahDivisi.replace(/#kegiatan|#rekap/gi, '').trim();

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

      // Deteksi tanggal dari teks pesan atau dari deskripsi hasil AI; kalau tidak
      // disebutkan sama sekali, pakai tanggal hari ini pesan diterima.
      const tanggalTerdeteksi = cariTanggalDiTeksServer(bersih) || cariTanggalDiTeksServer(deskripsi);
      const tanggalDate = tanggalTerdeteksi || new Date();
      const tanggal = formatTanggal(tanggalDate);
      const timestamp = Math.floor(tanggalDate.getTime() / 1000);

      const data = loadData();
      data.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        tanggal,
        timestamp,
        judul,
        deskripsi,
        foto: fotoCocok ? fotoCocok.directUrl : null,
        fotoDriveId: fotoCocok ? fotoCocok.fileId : null,
        divisi: divisiTerdeteksi,
        sumber: 'wa_teks',
      });
      saveData(data);

      let balasan = `✅ Kegiatan "${judul}" (${tanggal}) berhasil dicatat!`;
      balasan += fotoCocok
        ? `\n📷 Foto otomatis dipasangkan dari folder Drive.`
        : `\n📷 Belum ada foto yang cocok — upload foto ke folder Drive lalu kirim ulang kegiatannya jika perlu.`;
      if (divisiTerdeteksi) balasan += `\n🏷️ Divisi: ${divisiTerdeteksi}`;
      await kirimBalasanWA(sender, balasan);
      console.log(`   ✅ Disimpan: "${judul}" (${tanggal})${fotoCocok ? ' (dengan foto)' : ''}${divisiTerdeteksi ? ' [' + divisiTerdeteksi + ']' : ''}`);
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

  // Foto artikel website sudah punya URL publik sendiri (wp-content/uploads/...),
  // jadi langsung dipakai tanpa upload ulang ke Drive — menghindari keterbatasan
  // "service account tidak punya storage quota" saat membuat file baru di Drive biasa.
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    tanggal,
    timestamp,
    judul,
    deskripsi,
    foto: artikel.fotoUrl || null,
    fotoDriveId: null,
    divisi: null,
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

// ── SINKRONISASI: ambil kegiatan dari jurnal harian di folder Google Drive ──
// Folder berisi file jurnal (Google Docs atau file teks .txt) — 1 file biasanya
// mewakili 1 hari/1 kegiatan. Sistem membaca isi tiap file yang BELUM pernah
// diproses (dilacak lewat field "sumberFileId" pada data kegiatan tersimpan),
// lalu memakai AI untuk merapikan jadi judul + deskripsi kegiatan e-magazine.
//
// Catatan dukungan format:
// - Google Docs (application/vnd.google-apps.document) → diekspor sebagai teks polos.
// - File Word yang diupload (.docx) → teks diekstrak pakai library "mammoth".
// - File teks biasa (.txt, text/plain) → dibaca langsung.
// - Format lain (gambar, spreadsheet, .doc lama, PDF, dst) DILEWATI untuk saat ini — kalau
//   jurnal kamu berformat lain, konversi dulu ke salah satu format di atas, atau beri tahu
//   supaya dukungan formatnya bisa ditambahkan.
async function ambilFileJurnalBelumDiproses(idYangSudahDiproses = []) {
  const drive = getDrive();
  if (!drive || !JURNAL_FOLDER_ID) return [];
  try {
    const res = await drive.files.list({
      q: `'${JURNAL_FOLDER_ID}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')`,
      fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
      orderBy: 'createdTime asc',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const semua = res.data.files || [];
    return semua.filter(f => !idYangSudahDiproses.includes(f.id));
  } catch (e) {
    console.error('❌ Gagal ambil daftar file jurnal Drive:', e.message);
    return [];
  }
}

// Ambil isi teks dari 1 file jurnal (Google Docs diekspor sebagai text/plain, file .txt dibaca langsung).
async function ambilTeksFileJurnal(file) {
  const drive = getDrive();
  if (!drive) return null;
  try {
    if (file.mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export(
        { fileId: file.id, mimeType: 'text/plain' },
        { responseType: 'text' }
      );
      return typeof res.data === 'string' ? res.data : String(res.data);
    }
    if (file.mimeType === 'text/plain') {
      const buf = await downloadDriveFile(file.id);
      return buf ? buf.toString('utf8') : null;
    }
    if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const buf = await downloadDriveFile(file.id);
      if (!buf) return null;
      const mammoth = require('mammoth');
      const hasil = await mammoth.extractRawText({ buffer: buf });
      return hasil.value || null;
    }
    return null; // format tidak didukung
  } catch (e) {
    console.error(`❌ Gagal baca isi jurnal "${file.name}":`, e.message);
    return null;
  }
}

// Ubah 1 file jurnal jadi 1 entri kegiatan e-magazine. Kalau nama file atau isi jurnal
// menyebutkan tanggal, dipakai sebagai tanggal kegiatan; kalau tidak, pakai tanggal file
// dibuat di Drive sebagai cadangan.
async function prosesJurnalJadiKegiatan(file, teksMentah) {
  const { divisi: divisiTerdeteksi, teksBersih } = deteksiDivisiDiTeksServer(teksMentah);

  const tanggalTerdeteksi =
    cariTanggalDiTeksServer(file.name) ||
    cariTanggalDiTeksServer(teksBersih);
  const tanggalDate = tanggalTerdeteksi || new Date(file.createdTime || file.modifiedTime || Date.now());
  const tanggal = formatTanggal(tanggalDate);
  const timestamp = Math.floor(tanggalDate.getTime() / 1000);

  const deskripsi = await rapikanDeskripsi(teksBersih || file.name);
  const judul = await ekstrakJudul(deskripsi);

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    tanggal,
    timestamp,
    judul,
    deskripsi,
    foto: null,
    fotoDriveId: null,
    divisi: divisiTerdeteksi,
    sumber: 'jurnal',
    sumberFileId: file.id,
  };
}

// ── ENDPOINT: trigger sinkronisasi dari jurnal harian di Google Drive ──
app.post('/api/sync/jurnal', async (req, res) => {
  try {
    console.log('🔄 Mulai sinkron jurnal harian dari Google Drive...');
    const data = loadData();
    const idSudahDiproses = data.map(d => d.sumberFileId).filter(Boolean);

    const fileList = await ambilFileJurnalBelumDiproses(idSudahDiproses);
    let ditambah = 0, dilewati = 0;

    for (const file of fileList) {
      const teks = await ambilTeksFileJurnal(file);
      if (!teks || !teks.trim()) { dilewati++; continue; }
      const kegiatanBaru = await prosesJurnalJadiKegiatan(file, teks);
      data.push(kegiatanBaru);
      ditambah++;
    }
    saveData(data);

    console.log(`✅ Sinkron jurnal selesai: ${ditambah} kegiatan baru, ${dilewati} dilewati.`);
    res.json({ ok: true, diperiksa: fileList.length, ditambah, dilewati });
  } catch (e) {
    console.error('❌ Gagal sinkron jurnal Drive:', e.message);
    res.status(500).json({ error: 'Gagal sinkron dari jurnal Drive: ' + e.message });
  }
});

// ── SINKRONISASI: ambil kegiatan dari Google Calendar ─────────────────────
// Setiap event pada kalender organisasi dalam rentang tanggal tertentu diubah jadi
// 1 entri kegiatan e-magazine. Judul event dipakai sebagai judul kegiatan; deskripsi
// event (kalau ada) dirapikan oleh AI, kalau kosong dibuat deskripsi generik dari
// judul + waktu + lokasi event.
async function ambilEventKalender(dariISO, sampaiISO) {
  const calendar = getCalendar();
  if (!calendar) throw new Error('Google Calendar belum terhubung (cek GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN dan scope calendar.readonly)');

  const hasil = [];
  let pageToken = undefined;
  do {
    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: new Date(`${dariISO}T00:00:00`).toISOString(),
      timeMax: new Date(`${sampaiISO}T23:59:59`).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken,
    });
    (resp.data.items || []).forEach(ev => {
      if (ev.status === 'cancelled') return;
      const mulai = ev.start?.dateTime || ev.start?.date;
      if (!mulai) return;
      hasil.push({
        id: ev.id,
        judul: ev.summary || 'Kegiatan Tanpa Judul',
        deskripsi: ev.description || '',
        lokasi: ev.location || '',
        tanggalISO: mulai.slice(0, 10),
      });
    });
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  return hasil;
}

async function prosesEventJadiKegiatan(event) {
  const [th, bl, hr] = event.tanggalISO.split('-').map(Number);
  const tanggalDate = new Date(th, bl - 1, hr);
  const tanggal = formatTanggal(tanggalDate);
  const timestamp = Math.floor(tanggalDate.getTime() / 1000);

  const { divisi: divisiTerdeteksi, teksBersih: judulBersih } = deteksiDivisiDiTeksServer(event.judul);

  let deskripsi;
  if (event.deskripsi && event.deskripsi.trim()) {
    deskripsi = await rapikanDeskripsi(event.deskripsi);
  } else {
    const konteks = `Kegiatan "${judulBersih}" dijadwalkan pada ${tanggal}${event.lokasi ? ` di ${event.lokasi}` : ''}.`;
    deskripsi = await rapikanDeskripsi(konteks);
  }

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    tanggal,
    timestamp,
    judul: judulBersih.trim() || event.judul,
    deskripsi,
    foto: null,
    fotoDriveId: null,
    divisi: divisiTerdeteksi,
    sumber: 'calendar',
    sumberEventId: event.id,
  };
}

// ── ENDPOINT: trigger sinkronisasi dari Google Calendar (dipanggil manual oleh admin) ──
app.post('/api/sync/calendar', async (req, res) => {
  try {
    const dariISO   = req.body?.dariISO;
    const sampaiISO = req.body?.sampaiISO;
    if (!dariISO || !sampaiISO) return res.status(400).json({ error: 'Tanggal dari dan sampai wajib diisi' });
    console.log(`🔄 Mulai sinkron Google Calendar periode ${dariISO} s/d ${sampaiISO}...`);

    const eventList = await ambilEventKalender(dariISO, sampaiISO);
    const data = loadData();
    const idSudahAda = new Set(data.map(d => d.sumberEventId).filter(Boolean));

    let ditambah = 0, dilewati = 0;
    for (const event of eventList) {
      if (idSudahAda.has(event.id)) { dilewati++; continue; }
      const kegiatanBaru = await prosesEventJadiKegiatan(event);
      data.push(kegiatanBaru);
      idSudahAda.add(event.id);
      ditambah++;
    }
    saveData(data);

    console.log(`✅ Sinkron kalender selesai: ${ditambah} kegiatan baru, ${dilewati} dilewati (sudah ada).`);
    res.json({ ok: true, ditemukan: eventList.length, ditambah, dilewati });
  } catch (e) {
    console.error('❌ Gagal sinkron Google Calendar:', e.message);
    res.status(500).json({ error: 'Gagal sinkron dari Google Calendar: ' + e.message });
  }
});

// ── Export ringkasan (highlight) kegiatan ke DOCX ──────────
// Filter berdasarkan rentang tanggal ATAU kata kunci (cari di judul + deskripsi).
app.post('/api/export-docx', async (req, res) => {
  try {
    const { mode, dariISO, sampaiISO, kataKunci, divisi } = req.body;
    let data = loadData();
    let labelPeriode;

    if (mode === 'kata_kunci') {
      const kw = (kataKunci || '').trim().toLowerCase();
      if (!kw) return res.status(400).json({ error: 'Kata kunci wajib diisi' });
      data = data.filter(d =>
        (d.judul || '').toLowerCase().includes(kw) ||
        (d.deskripsi || '').toLowerCase().includes(kw)
      );
      labelPeriode = `Kata kunci: "${kataKunci.trim()}"`;
    } else {
      // mode 'tanggal' (default)
      if (!dariISO || !sampaiISO) return res.status(400).json({ error: 'Tanggal dari dan sampai wajib diisi' });
      const [thD, blD, hrD] = dariISO.split('-').map(Number);
      const [thS, blS, hrS] = sampaiISO.split('-').map(Number);
      const dariTs = Math.floor(new Date(thD, blD - 1, hrD, 0, 0, 0).getTime() / 1000);
      const sampaiTs = Math.floor(new Date(thS, blS - 1, hrS, 23, 59, 59).getTime() / 1000);
      data = data.filter(d => (d.timestamp || 0) >= dariTs && (d.timestamp || 0) <= sampaiTs);
      labelPeriode = `Periode: ${formatTanggal(new Date(thD, blD - 1, hrD))} – ${formatTanggal(new Date(thS, blS - 1, hrS))}`;
    }

    // Filter tambahan opsional berdasarkan divisi — bisa digabung dengan mode tanggal
    // ATAU kata kunci di atas. Hanya kegiatan yang SUDAH punya divisi eksplisit
    // tersimpan (dari form web atau tagar WA) yang bisa cocok di sini, karena
    // klasifikasi otomatis oleh AI baru terjadi saat dokumen DOCX dibuat, bukan
    // saat kegiatan disimpan.
    if (divisi && DAFTAR_DIVISI.includes(divisi)) {
      data = data.filter(d => d.divisi === divisi);
      labelPeriode += ` · Divisi: ${divisi}`;
    }

    data.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    if (!data.length) {
      return res.status(404).json({ error: 'Tidak ada kegiatan yang cocok dengan filter tersebut' });
    }
    if (data.length > 60) {
      return res.status(400).json({ error: `Terlalu banyak kegiatan (${data.length}). Persempit rentang tanggal atau kata kunci (maksimal 60 kegiatan per file).` });
    }

    const buffer = await buatDocxRingkasan(data, labelPeriode);
    const namaFile = `Ringkasan-Kegiatan-${Date.now()}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${namaFile}"`);
    res.send(buffer);
  } catch (e) {
    console.error('❌ Gagal export DOCX:', e.message);
    res.status(500).json({ error: 'Gagal membuat file DOCX: ' + e.message });
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
    const { tanggalISO, judul, deskripsi, fotoBase64, divisi } = req.body;
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
    let fotoGagal = false;
    if (fotoBase64) {
      const matches = fotoBase64.match(/^data:(image\/\w+);base64,(.+)$/);
      const mimeType = matches ? matches[1] : 'image/jpeg';
      const base64Data = matches ? matches[2] : fotoBase64;
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = mimeType.split('/')[1] || 'jpg';
      driveResult = await uploadKeDrive(buffer, `kegiatan_${Date.now()}.${ext}`, mimeType);
      // Kegiatan tetap disimpan walau upload foto gagal, tapi beri tahu
      // frontend supaya user tahu fotonya tidak masuk (bukan gagal senyap).
      if (!driveResult) fotoGagal = true;
    }

    // Divisi dari form web bersifat opsional — kalau kosong/tidak valid, biarkan null
    // supaya nanti diklasifikasikan otomatis oleh AI saat export DOCX.
    const divisiValid = DAFTAR_DIVISI.includes(divisi) ? divisi : null;

    const data = loadData();
    data.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      tanggal,
      timestamp,
      judul,
      deskripsi,
      foto: driveResult ? driveResult.directUrl : null,
      fotoDriveId: driveResult ? driveResult.fileId : null,
      divisi: divisiValid,
      sumber: 'manual',
    });
    saveData(data);
    res.json({ ok: true, fotoGagal });
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

app.put('/api/kegiatan/:id', async (req, res) => {
  try {
    let data = loadData();
    const idx = data.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Tidak ditemukan' });

    const { tanggalISO, fotoBase64, ...rest } = req.body;
    const updates = { ...rest };

    // Kalau field divisi ikut dikirim, validasi terhadap daftar resmi — nilai kosong
    // atau tidak dikenali akan disimpan sebagai null (berarti "otomatis oleh AI").
    if (Object.prototype.hasOwnProperty.call(updates, 'divisi')) {
      updates.divisi = DAFTAR_DIVISI.includes(updates.divisi) ? updates.divisi : null;
    }

    if (tanggalISO) {
      const [th, bl, hr] = tanggalISO.split('-').map(Number);
      if (th && bl && hr) {
        const tanggalDate = new Date(th, bl - 1, hr);
        updates.tanggal = formatTanggal(tanggalDate);
        updates.timestamp = Math.floor(tanggalDate.getTime() / 1000);
      }
    }

    let fotoGagal = false;
    if (fotoBase64) {
      const matches = fotoBase64.match(/^data:(image\/\w+);base64,(.+)$/);
      const mimeType = matches ? matches[1] : 'image/jpeg';
      const base64Data = matches ? matches[2] : fotoBase64;
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = mimeType.split('/')[1] || 'jpg';
      const driveResult = await uploadKeDrive(buffer, `kegiatan_${Date.now()}.${ext}`, mimeType);
      if (driveResult) {
        // Hapus foto lama di Drive supaya tidak menumpuk file yang sudah tidak dipakai.
        const fotoDriveIdLama = data[idx].fotoDriveId;
        if (fotoDriveIdLama) {
          const drive = getDrive();
          if (drive) await drive.files.delete({ fileId: fotoDriveIdLama, supportsAllDrives: true }).catch(() => {});
        }
        updates.foto = driveResult.directUrl;
        updates.fotoDriveId = driveResult.fileId;
      } else {
        // Upload gagal -> foto lama (kalau ada) tetap dipakai, jangan ditimpa dengan null.
        fotoGagal = true;
      }
    }

    data[idx] = { ...data[idx], ...updates };
    saveData(data);
    res.json({ ok: true, fotoGagal });
  } catch (e) {
    console.error('❌ Gagal update kegiatan:', e.message);
    res.status(500).json({ error: 'Gagal update' });
  }
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
const KEGIATAN_PER_SLIDE = 3; // 3 kegiatan tiap slide — dikurangi dari 4 supaya tiap kartu cukup ruang untuk teks ringkasan 5W+1H

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
      const res = await axios.get(item.foto, { responseType: 'arraybuffer', timeout: 15000 });
      // Pakai content-type asli dari response, jangan dipaksa jpeg — kalau formatnya
      // sebenarnya PNG/WebP tapi dideklarasikan jpeg, sebagian renderer SVG gagal
      // mendekode dan gambarnya jadi hilang total dari slide.
      let mimeType = (res.headers['content-type'] || '').split(';')[0].trim();
      if (!mimeType || !mimeType.startsWith('image/')) mimeType = 'image/jpeg';
      return `data:${mimeType};base64,${Buffer.from(res.data).toString('base64')}`;
    }
  } catch (e) { console.error('⚠️  Gagal ambil foto untuk carousel:', e.message); }
  return null;
}

// ── AI: ringkasan khusus carousel — padat tapi mencakup 5W+1H ─────────────
// targetKata disesuaikan dari pemanggil berdasarkan berapa banyak kartu berbagi 1 slide,
// supaya ringkasan tidak terpotong di tengah kalimat saat ruang kartu lebih sempit.
async function buatRingkasanCarousel(item, targetKata = '45-65 kata dalam 1 paragraf utuh') {
  const teksAsli = item.deskripsi || item.judul || '';
  if (!ANTHROPIC_KEY) return teksAsli;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 220,
      messages: [{
        role: 'user',
        content: `Buat ringkasan kegiatan untuk slide carousel Instagram dalam bentuk SATU PARAGRAF UTUH (bukan poin-poin), sekitar ${targetKata}, Bahasa Indonesia, gaya jurnalistik singkat seperti pada e-magazine resmi. Sertakan unsur 5W+1H sejauh tersedia di teks asli (siapa yang terlibat, apa kegiatannya, kapan ${item.tanggal ? `— gunakan tanggal "${item.tanggal}" jika teks asli tidak menyebutkan tanggal eksplisit` : ''}, di mana, mengapa/tujuannya, bagaimana pelaksanaannya). Tulis paragraf yang mengalir lengkap dan tidak terpotong di tengah kalimat — usahakan memenuhi target panjang kata di atas agar paragraf terasa penuh dan informatif, bukan cuma satu kalimat pendek. Jangan menambah fakta yang tidak ada di teks asli. Langsung tulis paragrafnya saja tanpa kata pengantar, label, atau tanda kutip:\n\nJudul: "${item.judul || ''}"\nTeks asli: "${teksAsli.slice(0, 900)}"`
      }]
    });
    return resp.content[0].text.trim();
  } catch (e) {
    console.error('⚠️  Gagal buat ringkasan carousel:', e.message);
    return teksAsli;
  }
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

// Sama seperti linesToTspans, tapi tiap baris yang sudah cukup "penuh" (kecuali baris terakhir)
// direntangkan pas selebar kotak (textLength + lengthAdjust) supaya hasilnya rata kiri-kanan (justified),
// meniru tampilan paragraf rapi di halaman web (mwotm.mitrawacana.or.id). Baris yang masih jauh dari
// penuh (mis. sisa 1-2 kata pendek) TIDAK dipaksa rata supaya tidak terlihat "merenggang" tidak wajar.
function linesToTspansJustified(lines, x, y, lineHeight, widthPx, maxCharsPerLine) {
  return lines.map((line, i) => {
    const isLast = i === lines.length - 1;
    const bolehJustify = !isLast && line.trim().includes(' ');
    const attrs = bolehJustify ? ` textLength="${widthPx}" lengthAdjust="spacingAndGlyphs"` : '';
    return `<tspan x="${x}" y="${y + i * lineHeight}"${attrs}>${escapeXml(line)}</tspan>`;
  }).join('');
}

// Saat paragraf tidak muat penuh, potong di akhir KALIMAT terakhir yang masih utuh
// (diakhiri . ! ?) — bukan di tengah kata dengan tanda "…". Kalau tidak ada batas kalimat
// sama sekali di dalam batas yang muat, potong di batas kata terakhir (tanpa elipsis aneh).
function potongSampaiTitik(prefixWords) {
  const matches = [...prefixWords.matchAll(/[.!?](?=\s|$)/g)];
  if (matches.length) {
    const last = matches[matches.length - 1];
    return prefixWords.slice(0, last.index + 1).trim();
  }
  return prefixWords.trim();
}

// Cari paragraf yang MEMENUHI kotak kartu: coba font terbesar dulu, makin kecil sampai
// seluruh teks (tanpa terpotong) muat dalam batas lebar & tinggi yang tersedia.
// Hasilnya: font sebesar mungkin yang masih pas → teks terasa "penuh" sampai batas kotak,
// bukan cuma 1-2 baris pendek yang menyisakan ruang kosong di bawah.
// PENTING: dipakai garis aman (safety factor) pada estimasi lebar karakter supaya teks TIDAK PERNAH
// melebihi batas kartu — lebih baik baris dihitung sedikit lebih pendek dari kapasitas asli
// (sehingga stretch justify-nya kecil & rapi) daripada under-estimate dan akhirnya kepotong/meluber.
function fitParagraphToBox(text, widthPx, heightPx, maxFontSize, minFontSize, lineHeightRatio = 1.3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let best = null;
  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 0.5) {
    const avgCharW = fontSize * 0.56; // estimasi lebar rata-rata karakter (sengaja agak lebar/konservatif)
    const maxCharsPerLine = Math.max(8, Math.floor(widthPx / avgCharW));
    const lineHeight = Math.round(fontSize * lineHeightRatio);
    const maxLines = Math.max(1, Math.floor(heightPx / lineHeight));

    // Coba bungkus SELURUH teks (tanpa batas baris) untuk lihat apakah muat dalam maxLines
    const lines = [];
    let current = '';
    for (const w of words) {
      const test = current ? current + ' ' + w : w;
      if (test.length > maxCharsPerLine && current) { lines.push(current); current = w; }
      else current = test;
    }
    if (current) lines.push(current);

    if (lines.length <= maxLines) {
      // Cocok tanpa terpotong — ini font terbesar yang pas, pakai ini.
      best = { fontSize, lineHeight, lines, maxCharsPerLine, truncated: false };
      break;
    }
    // Tidak muat penuh: ambil sebanyak maxLines baris (kata-kata utuh, tidak ada yang terpotong
    // di tengah), lalu rapikan ujungnya supaya berhenti tepat di akhir kalimat (titik/!/?).
    const prefixWords = lines.slice(0, maxLines).join(' ');
    const rapi = potongSampaiTitik(prefixWords);
    const reLines = [];
    let cur2 = '';
    for (const w of rapi.split(/\s+/).filter(Boolean)) {
      const test2 = cur2 ? cur2 + ' ' + w : w;
      if (test2.length > maxCharsPerLine && cur2) { reLines.push(cur2); cur2 = w; }
      else cur2 = test2;
    }
    if (cur2) reLines.push(cur2);
    // Jaga-jaga: kalau hasil rapikan ternyata masih lebih dari maxLines (jarang terjadi karena
    // teks sudah dipersingkat), pangkas baris kelebihannya tanpa elipsis.
    best = { fontSize, lineHeight, lines: reLines.slice(0, maxLines), maxCharsPerLine, truncated: true };
  }
  return best || { fontSize: minFontSize, lineHeight: Math.round(minFontSize * lineHeightRatio), lines: [], maxCharsPerLine: 10, truncated: false };
}

// Bungkus teks judul (bold) pada ukuran font tertentu — dipakai untuk mencoba beberapa
// ukuran judul dari besar ke kecil agar deskripsi dapat ruang lebih saat diperlukan.
function wrapJudulAtSize(text, widthPx, fontSize, maxLines) {
  const avgCharW = fontSize * 0.66; // bold & besar — pakai faktor konservatif supaya tidak meluber ke kanan
  const maxChars = Math.max(8, Math.floor(widthPx / avgCharW));
  return wrapToLines(text, maxChars, maxLines);
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
  // Slide dengan lebih banyak kartu (ruang lebih sempit) → minta ringkasan AI lebih singkat
  // supaya tidak terpotong di tengah kalimat.
  const targetKata = items.length >= 3 ? '30-45 kata dalam 1 paragraf utuh' : '45-60 kata dalam 1 paragraf utuh';
  const ringkasanData = await Promise.all(items.map(it => buatRingkasanCarousel(it, targetKata)));

  // Ukuran font & jumlah baris judul menyesuaikan kepadatan slide (ukuran aktual ditentukan
  // per-kartu lewat loop penyesuaian di bawah, supaya deskripsi bisa diberi ruang lebih).
  const kompak = items.length >= 3;
  const maxJudulLines = kompak ? 3 : 2;

  // Lebar teks menyesuaikan ukuran foto (foto lebih besar → teks lebih sempit)
  const fotoX = 56;
  const textX = fotoX + fotoSize + 32;
  const textAvailPx = (W - 40) - textX - 24;

  let cardsSvg = '';
  items.forEach((item, i) => {
    const y = cardTop + i * (cardH + cardGap);
    const foto = fotoData[i];
    const fotoY = y + (cardH - fotoSize) / 2;

    // Konstanta tata letak blok teks — dipakai SAMA PERSIS untuk menghitung jatah tinggi
    // deskripsi maupun tinggi blok akhir, supaya dijamin tidak pernah meluber dari kartu.
    const MARGIN_TOP = 18, MARGIN_BOTTOM = 18, dateH = 26, gapDateJudul = 14, gapJudulDesk = 14;

    // Coba beberapa ukuran judul dari BESAR ke KECIL. Untuk tiap ukuran judul, cek apakah
    // deskripsi muat penuh (tanpa terpotong) di sisa ruang. Pakai judul terbesar yang sudah
    // bikin deskripsi muat penuh; kalau sampai ukuran judul terkecil pun deskripsi tetap belum
    // muat semua, tetap pakai ukuran judul terkecil itu (supaya ruang deskripsi paling lega) —
    // fitParagraphToBox akan memotongnya rapi sampai akhir kalimat, bukan di tengah kata.
    const judulSizeOptions = kompak ? [23, 21, 19, 17, 16, 15, 14] : [26, 24, 22, 20, 18, 16, 15];
    let judulFontSizeAktual, judulLineHAktual, judulLines, sisaTinggiDesk, fit;
    for (let opt = 0; opt < judulSizeOptions.length; opt++) {
      const jSize = judulSizeOptions[opt];
      const jLineH = Math.round(jSize * 1.17);
      const jLines = wrapJudulAtSize(item.judul || 'Tanpa Judul', textAvailPx, jSize, maxJudulLines);
      const tinggiTetap = MARGIN_TOP + MARGIN_BOTTOM + dateH + gapDateJudul + jLines.length * jLineH + gapJudulDesk;
      const sisa = Math.max(0, cardH - tinggiTetap);
      const cobaFit = fitParagraphToBox(
        ringkasanData[i] || item.deskripsi || '',
        textAvailPx,
        sisa,
        kompak ? 18 : 20,   // font maksimum dicoba untuk deskripsi
        14                  // font minimum sebelum dipotong sampai akhir kalimat (jangan terlalu kecil)
      );
      judulFontSizeAktual = jSize; judulLineHAktual = jLineH; judulLines = jLines; sisaTinggiDesk = sisa; fit = cobaFit;
      if (!cobaFit.truncated || opt === judulSizeOptions.length - 1) break;
    }
    const deskLines = fit.lines;
    const deskLineH = fit.lineHeight;
    const deskFontSizeAktual = fit.fontSize;

    // Tinggi total blok teks (tanggal + judul + jarak + deskripsi), dipusatkan vertikal dalam kartu.
    // Karena deskLines selalu <= sisaTinggiDesk/deskLineH, blokTinggi dijamin <= cardH - margin atas-bawah.
    const blokTinggi = dateH + gapDateJudul + judulLines.length * judulLineHAktual + gapJudulDesk + deskLines.length * deskLineH;
    const blokY = y + (cardH - blokTinggi) / 2;

    const tanggalY = blokY + 18;
    const judulY = tanggalY + 14 + 22;
    const deskY = judulY + (judulLines.length - 1) * judulLineHAktual + 14 + 18;

    cardsSvg += `
    <rect x="40" y="${y}" width="${W - 80}" height="${cardH}" rx="20" fill="rgba(255,255,255,0.12)"/>
    ${foto
      ? `<clipPath id="clip${i}"><rect x="${fotoX}" y="${fotoY}" width="${fotoSize}" height="${fotoSize}" rx="16"/></clipPath>
         <image href="${foto}" x="${fotoX}" y="${fotoY}" width="${fotoSize}" height="${fotoSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip${i})"/>`
      : `<rect x="${fotoX}" y="${fotoY}" width="${fotoSize}" height="${fotoSize}" rx="16" fill="rgba(255,255,255,0.18)"/>
         <text x="${fotoX + fotoSize/2}" y="${fotoY + fotoSize/2 + 16}" font-size="48" text-anchor="middle">📷</text>`
    }
    <text x="${textX}" y="${tanggalY}" font-family="Nunito, sans-serif" font-size="22" font-weight="800" fill="#f5c842">${escapeXml(item.tanggal || '')}</text>
    <text font-family="Nunito, sans-serif" font-size="${judulFontSizeAktual}" font-weight="800" fill="white">${linesToTspans(judulLines, textX, judulY, judulLineHAktual)}</text>
    <text font-family="Nunito, sans-serif" font-size="${deskFontSizeAktual}" fill="rgba(255,255,255,0.85)">${linesToTspansJustified(deskLines, textX, deskY, deskLineH, textAvailPx, fit.maxCharsPerLine)}</text>
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
    <text x="56" y="90" font-family="Nunito, sans-serif" font-size="30" font-weight="900" fill="white" letter-spacing="2">MW ON THE MONTH</text>
    <rect x="56" y="108" width="64" height="8" rx="4" fill="#f5c842"/>
    <text x="56" y="190" font-family="Nunito, sans-serif" font-size="64" font-weight="900" fill="#f5c842">${escapeXml(bulanLabel.toUpperCase())}</text>
    ${logoSvg}
    ${totalSlide > 1 && !LOGO_BASE64 ? `<text x="${W - 56}" y="90" font-family="Nunito, sans-serif" font-size="26" font-weight="800" fill="rgba(255,255,255,0.7)" text-anchor="end">${slideKe}/${totalSlide}</text>` : ''}
    ${totalSlide > 1 && LOGO_BASE64 ? `<text x="${W - 56}" y="${logoY + logoH + 26}" font-family="Nunito, sans-serif" font-size="22" font-weight="800" fill="rgba(255,255,255,0.7)" text-anchor="end">${slideKe}/${totalSlide}</text>` : ''}
    ${cardsSvg}
    <rect x="40" y="${H - 70}" width="${W - 80}" height="50" rx="14" fill="#f5c842"/>
    <text x="${W/2}" y="${H - 36}" font-family="Nunito, sans-serif" font-size="22" font-weight="800" fill="${tcDark}" text-anchor="middle">${escapeXml(ORG_NAMA)} · ${escapeXml(FOOTER_SOCMED)}</text>
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
  html, body { background: var(--tc-dark) !important; margin: 0 !important; padding: 0 !important; }
  .topbar, .modal-bg, .lightbox-bg, .card-actions { display: none !important; }
  .tl-item { break-inside: avoid; page-break-inside: avoid; margin-bottom: 28px; }
  .card {
    break-inside: avoid; page-break-inside: avoid;
    backdrop-filter: none !important;
    background: #ffffff !important;
    border: none !important;
    box-shadow: 0 2px 10px rgba(0,0,0,0.25) !important;
  }
  .card-desc { color: #2d1a2e !important; font-weight: 600 !important; font-family: 'Nunito', Arial, sans-serif !important; }
  .card-judul { color: var(--tc-dark) !important; font-weight: 900 !important; font-size: 1.05rem !important; font-family: 'Nunito', Arial, sans-serif !important; }
  .timeline::before { background: rgba(255,255,255,0.6) !important; }
  .footer-bar { break-inside: avoid; page-break-inside: avoid; margin-top: 16px; }
  /* Padding di sini SELALU diterapkan (tidak bergantung pengaturan margin di dialog print browser),
     supaya konten tidak pernah mepet ke tepi halaman walau setting printer berbeda-beda. */
  .mag-wrap { max-width: 100%; padding: 36px 26px 30px; }
  .cover { padding-top: 0; }
  .cover-title { color: white !important; }
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
.card-divisi { display:inline-block; font-size:0.68rem; font-weight:800; color:var(--dark); background:var(--yellow); border-radius:6px; padding:2px 8px; margin-bottom:6px; }
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
.modal input, .modal textarea, .modal select { width:100%; padding:9px 12px; border:1.5px solid #ddd; border-radius:8px; font-size:0.9rem; margin-bottom:12px; font-family:'Nunito',sans-serif; }
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
    <button class="btn-gen" onclick="bukaPrintModal()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print / PDF</button>
    <button class="btn-gen" onclick="buatCarousel()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Buat Carousel IG</button>
    <button class="btn-gen" id="sync-website-btn" onclick="syncWebsite()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg> Sync dari Website</button>
    <button class="btn-gen" id="sync-jurnal-btn" onclick="syncJurnal()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> Sync dari Jurnal Drive</button>
    <button class="btn-gen" id="sync-calendar-btn" onclick="syncCalendar()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Sync dari Kalender</button>
    <button class="btn-gen" onclick="bukaExportDocxModal()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="15" y2="11"/></svg> Ringkasan DOCX</button>
  </div>
</div>
<div class="modal-bg" id="carousel-modal">
  <div class="modal">
    <h3>Carousel Instagram</h3>
    <label>Pilih Bulan</label>
    <select id="carousel-bulan-select" onchange="muatSlideCarousel(this.value)" style="width:100%;padding:10px;border-radius:8px;border:1px solid #ccc;margin:6px 0 12px;font-size:1rem;"></select>
    <p id="carousel-info" style="color:#444;margin:10px 0;">Menyiapkan slide...</p>
    <div id="carousel-list" style="display:flex;flex-direction:column;gap:8px;max-height:300px;overflow-y:auto;"></div>
    <button class="btn-gen" id="carousel-download-all-btn" onclick="downloadSemuaSlide()" style="justify-content:center;margin-top:10px;display:none;"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download Semua Slide</button>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeCarouselModal()">Tutup</button>
    </div>
  </div>
</div>
<div class="modal-bg" id="print-modal">
  <div class="modal">
    <h3>Print / PDF</h3>
    <label>Pilih Bulan</label>
    <select id="print-bulan-select" style="width:100%;padding:10px;border-radius:8px;border:1px solid #ccc;margin:6px 0 12px;font-size:1rem;"></select>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closePrintModal()">Batal</button>
      <button class="btn-save" onclick="cetakPDF()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print</button>
    </div>
  </div>
</div>
<div class="modal-bg" id="export-docx-modal">
  <div class="modal">
    <h3>Ringkasan DOCX (Output / Kegiatan / Deskripsi)</h3>
    <label>Filter berdasarkan</label>
    <select id="docx-mode-select" onchange="gantiModeExportDocx()" style="width:100%;padding:10px;border-radius:8px;border:1px solid #ccc;margin:6px 0 12px;font-size:1rem;">
      <option value="tanggal">Rentang Tanggal</option>
      <option value="kata_kunci">Kata Kunci</option>
    </select>
    <div id="docx-filter-tanggal">
      <label>Dari Tanggal</label><input type="date" id="docx-dari-tanggal">
      <label>Sampai Tanggal</label><input type="date" id="docx-sampai-tanggal">
    </div>
    <div id="docx-filter-kata-kunci" style="display:none;">
      <label>Kata Kunci</label><input type="text" id="docx-kata-kunci" placeholder="mis: pornografi, migran, gender">
    </div>
    <label>Divisi (opsional)</label>
    <select id="docx-divisi-select"><option value="">— Semua Divisi —</option></select>
    <p style="color:#666;font-size:0.85rem;margin-top:-4px;margin-bottom:10px;">Hanya berlaku untuk kegiatan yang sudah punya divisi tersimpan (dipilih manual di form Tambah/Edit, atau lewat tagar divisi di WA).</p>
    <p style="color:#666;font-size:0.85rem;margin-top:10px;">File akan berisi tabel highlight (Output, Kegiatan, Deskripsi Singkat) yang dibuat otomatis dari kegiatan yang cocok dengan filter di atas. Maksimal 60 kegiatan per file.</p>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeExportDocxModal()">Batal</button>
      <button class="btn-save" id="docx-export-btn" onclick="exportDocx()"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Buat &amp; Download</button>
    </div>
  </div>
</div>
<div class="mag-wrap">
  <div class="cover">
    <img src="${LOGO_URL_PUBLIK}" alt="${ORG_NAMA}" class="cover-logo">
    <div class="cover-title">MW ON THE MONTH</div>
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
    <label>Divisi (opsional)</label>
    <select id="add-divisi"><option value="">— Otomatis (AI menentukan saat export) —</option></select>
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
    <label>Divisi (opsional)</label>
    <select id="edit-divisi"><option value="">— Otomatis (AI menentukan saat export) —</option></select>
    <label>Foto (opsional — kosongkan jika tidak ingin mengganti)</label><input type="file" id="edit-foto" accept="image/*">
    <div id="edit-foto-preview" style="margin:6px 0 12px;"></div>
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
const DAFTAR_DIVISI_FRONTEND = ${JSON.stringify(DAFTAR_DIVISI)};
function populateDivisiSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— Otomatis (AI menentukan saat export) —</option>' +
    DAFTAR_DIVISI_FRONTEND.map(d => '<option value="'+d+'">'+d+'</option>').join('');
}
populateDivisiSelect('add-divisi');
populateDivisiSelect('edit-divisi');
(function populateDocxDivisiSelect() {
  const sel = document.getElementById('docx-divisi-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Semua Divisi —</option>' +
    DAFTAR_DIVISI_FRONTEND.map(d => '<option value="'+d+'">'+d+'</option>').join('');
})();

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
  const filterAktif = document.getElementById('filter-bulan').value.trim();
  const labelCover = filterAktif || 'Tahun 2026';
  document.getElementById('cover-month').textContent = labelCover.toUpperCase();
  if (!allData.length) { tl.innerHTML = '<div class="empty">📭 Belum ada kegiatan.<br><br>Kirim foto/teks #kegiatan ke grup WA</div>'; return; }
  tl.innerHTML = allData.map(item => {
    const dayMatch = item.tanggal?.match(/^(\\d+)/);
    const day = dayMatch ? dayMatch[1] : '?';
    const monthYr = item.tanggal?.replace(/^\\d+\\s*/, '') || '';
    const fotoUrl = (item.foto || '').replace(/'/g, '&#39;');
    const fotoHTML = item.foto ? '<img src="'+fotoUrl+'" loading="lazy" onclick="openLightbox(\\''+fotoUrl+'\\')" onerror="this.outerHTML=\\'<div class=&quot;card-nofoto&quot;>📷</div>\\'">' : '<div class="card-nofoto">📷</div>';
    const divisiHTML = item.divisi ? '<div class="card-divisi">'+item.divisi+'</div>' : '';
    return '<div class="tl-item"><div class="bubble"><span class="day">'+day+'</span><span class="myr">'+monthYr+'</span></div><div class="card">'+fotoHTML+'<div class="card-body">'+divisiHTML+'<div class="card-judul">"'+(item.judul||'Tanpa Judul')+'"</div><div class="card-desc">'+(item.deskripsi||'')+'</div><div class="card-actions"><button class="btn-edit" onclick="openEdit(\\''+item.id+'\\')"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit</button><button class="btn-del" onclick="hapus(\\''+item.id+'\\')"><svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Hapus</button></div></div></div></div>';
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
// Cari tanggal yang disebutkan di dalam teks bebas, misal:
// "Pada 28 Juni, Mitra Wacana..." atau "5 hingga 7 Juni 2026" -> ambil tanggal pertama.
// Kalau tahun tidak disebutkan di teks, pakai tahunDefault (atau tahun berjalan).
function cariTanggalDiTeks(teks, tahunDefault) {
  if (!teks) return '';
  const namaBulanRegex = NAMA_BULAN_ID.join('|');
  const re = new RegExp('\\b(\\d{1,2})\\b(?:\\s*(?:[-–]|hingga|sampai)\\s*\\d{1,2}\\s*)?\\s+(' + namaBulanRegex + ')\\b(?:\\s+(\\d{4}))?', 'i');
  const m = teks.match(re);
  if (!m) return '';
  const hari = parseInt(m[1], 10);
  const bulanIdx = NAMA_BULAN_ID.findIndex(b => b.toLowerCase() === m[2].toLowerCase());
  const tahun = m[3] ? parseInt(m[3], 10) : (tahunDefault || new Date().getFullYear());
  if (!hari || hari > 31 || bulanIdx === -1) return '';
  const mm = String(bulanIdx + 1).padStart(2, '0');
  const dd = String(hari).padStart(2, '0');
  return tahun + '-' + mm + '-' + dd;
}
let editTanggalManual = false;
let editFotoBase64 = null; // null = foto tidak diganti; string = foto baru dipilih user
function openEdit(id) {
  const item = allData.find(d => d.id === id);
  if (!item) return;
  document.getElementById('edit-id').value = id;
  editTanggalManual = false;
  // Kalau tanggal tersimpan tidak bisa diparse (mis. formatnya tidak lengkap),
  // coba deteksi otomatis dari kalimat pertama deskripsi sebagai cadangan.
  let isoTanggal = tanggalIdKeISO(item.tanggal) || cariTanggalDiTeks(item.deskripsi || '');
  document.getElementById('edit-tanggal').value = isoTanggal;
  document.getElementById('edit-judul').value = item.judul || '';
  document.getElementById('edit-desc').value = item.deskripsi || '';
  document.getElementById('edit-divisi').value = item.divisi || '';
  editFotoBase64 = null;
  document.getElementById('edit-foto').value = '';
  document.getElementById('edit-foto-preview').innerHTML = item.foto
    ? '<img src="' + item.foto.replace(/"/g,'&quot;') + '" style="max-width:120px;max-height:120px;border-radius:8px;">'
    : '';
  document.getElementById('modal').classList.add('open');
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }
function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }

let addFotoBase64 = null;
let addTanggalManual = false;
function openAddModal() {
  document.getElementById('add-tanggal').value = new Date().toISOString().slice(0,10);
  document.getElementById('add-judul').value = '';
  document.getElementById('add-desc').value = '';
  document.getElementById('add-divisi').value = '';
  document.getElementById('add-foto').value = '';
  document.getElementById('add-foto-preview').innerHTML = '';
  addFotoBase64 = null;
  addTanggalManual = false;
  document.getElementById('add-modal').classList.add('open');
}
function closeAddModal() { document.getElementById('add-modal').classList.remove('open'); }
document.getElementById('add-tanggal').addEventListener('input', () => { addTanggalManual = true; });
document.getElementById('add-desc').addEventListener('blur', () => {
  if (addTanggalManual) return; // jangan timpa kalau user sudah pilih tanggal sendiri
  const iso = cariTanggalDiTeks(document.getElementById('add-desc').value);
  if (iso) document.getElementById('add-tanggal').value = iso;
});
document.getElementById('edit-tanggal').addEventListener('input', () => { editTanggalManual = true; });
document.getElementById('edit-desc').addEventListener('blur', () => {
  if (editTanggalManual) return;
  const iso = cariTanggalDiTeks(document.getElementById('edit-desc').value);
  if (iso) document.getElementById('edit-tanggal').value = iso;
});
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
document.getElementById('edit-foto').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return; // batal pilih file -> foto lama tetap dipakai
  const reader = new FileReader();
  reader.onload = function() {
    editFotoBase64 = reader.result;
    document.getElementById('edit-foto-preview').innerHTML = '<img src="' + editFotoBase64 + '" style="max-width:120px;max-height:120px;border-radius:8px;">';
  };
  reader.readAsDataURL(file);
});
async function simpanTambah() {
  const tanggalISO = document.getElementById('add-tanggal').value;
  const judul = document.getElementById('add-judul').value.trim();
  const deskripsi = document.getElementById('add-desc').value.trim();
  const divisi = document.getElementById('add-divisi').value;
  if (!judul || !deskripsi) { alert('Judul dan deskripsi wajib diisi'); return; }
  const btn = document.getElementById('add-save-btn');
  const btnHtmlAsli = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    const r = await fetch('/api/kegiatan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tanggalISO, judul, deskripsi, divisi, fotoBase64: addFotoBase64 })
    });
    if (!r.ok) throw new Error('gagal');
    const hasil = await r.json();
    closeAddModal();
    loadData();
    if (hasil.fotoGagal) alert('Kegiatan tersimpan, tapi foto gagal diupload ke Google Drive. Cek koneksi Drive lalu coba edit kegiatan untuk menambahkan foto lagi.');
  } catch (e) {
    alert('Gagal menyimpan kegiatan');
  } finally {
    btn.disabled = false; btn.innerHTML = btnHtmlAsli;
  }
}

function daftarBulanUnik() {
  // Ambil daftar "Bulan Tahun" unik dari seluruh data (bukan hanya yang sedang difilter),
  // diurutkan dari yang terbaru ke terlama.
  const map = new Map();
  allDataSemua.forEach(item => {
    const label = item.tanggal?.split(' ').slice(1).join(' ');
    if (label && !map.has(label)) map.set(label, item.timestamp || 0);
  });
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);
}

async function buatCarousel() {
  const modal = document.getElementById('carousel-modal');
  const select = document.getElementById('carousel-bulan-select');
  modal.classList.add('open');

  if (!allDataSemua.length) await muatSemuaDataUntukCarousel();

  const filterAktif = document.getElementById('filter-bulan').value.trim();
  const daftarBulan = daftarBulanUnik();
  select.innerHTML = '<option value="">Semua Bulan</option>' +
    daftarBulan.map(b => '<option value="'+b+'">'+b+'</option>').join('');
  select.value = daftarBulan.includes(filterAktif) ? filterAktif : '';

  muatSlideCarousel(select.value);
}

let allDataSemua = []; // cache seluruh data (tanpa filter) khusus untuk daftar pilihan bulan carousel
async function muatSemuaDataUntukCarousel() {
  try {
    const r = await fetch('/api/kegiatan');
    allDataSemua = await r.json();
  } catch { allDataSemua = []; }
}

async function muatSlideCarousel(bulan) {
  const info = document.getElementById('carousel-info');
  const list = document.getElementById('carousel-list');
  const btnSemua = document.getElementById('carousel-download-all-btn');
  list.innerHTML = '';
  btnSemua.style.display = 'none';
  daftarUrlSlide = [];
  info.textContent = 'Menyiapkan slide...';
  try {
    const r = await fetch('/api/carousel-info' + (bulan ? '?bulan=' + encodeURIComponent(bulan) : ''));
    const d = await r.json();
    if (!d.totalSlide) { info.textContent = 'Tidak ada kegiatan untuk dibuatkan carousel.'; return; }
    info.textContent = d.totalKegiatan + ' kegiatan → ' + d.totalSlide + ' slide. Klik untuk download tiap slide:';
    for (let i = 1; i <= d.totalSlide; i++) {
      const url = '/api/carousel-slide?slide=' + i + (bulan ? '&bulan=' + encodeURIComponent(bulan) : '');
      daftarUrlSlide.push({ url, filename: 'carousel-slide-' + i + '.png' });
      const a = document.createElement('a');
      a.href = url; a.download = 'carousel-slide-' + i + '.png';
      a.className = 'btn-gen'; a.style.justifyContent = 'center';
      a.innerHTML = '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download Slide ' + i + ' / ' + d.totalSlide;
      list.appendChild(a);
    }
    if (d.totalSlide > 1) btnSemua.style.display = 'flex';
  } catch (e) { info.textContent = 'Gagal menyiapkan carousel.'; }
}

let daftarUrlSlide = [];
async function downloadSemuaSlide() {
  const btn = document.getElementById('carousel-download-all-btn');
  const asli = btn.innerHTML;
  btn.disabled = true;
  for (let i = 0; i < daftarUrlSlide.length; i++) {
    btn.textContent = 'Mengunduh ' + (i + 1) + ' / ' + daftarUrlSlide.length + '...';
    const { url, filename } = daftarUrlSlide[i];
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Jeda singkat antar download supaya browser tidak memblokir unduhan beruntun
    await new Promise(r => setTimeout(r, 600));
  }
  btn.disabled = false; btn.innerHTML = asli;
}
function closeCarouselModal() { document.getElementById('carousel-modal').classList.remove('open'); }

async function bukaPrintModal() {
  const modal = document.getElementById('print-modal');
  const select = document.getElementById('print-bulan-select');
  if (!allDataSemua.length) await muatSemuaDataUntukCarousel();
  const filterAktif = document.getElementById('filter-bulan').value.trim();
  const daftarBulan = daftarBulanUnik();
  select.innerHTML = '<option value="">Semua Bulan</option>' +
    daftarBulan.map(b => '<option value="'+b+'">'+b+'</option>').join('');
  select.value = daftarBulan.includes(filterAktif) ? filterAktif : '';
  modal.classList.add('open');
}
function closePrintModal() { document.getElementById('print-modal').classList.remove('open'); }

function bukaExportDocxModal() {
  const modal = document.getElementById('export-docx-modal');
  document.getElementById('docx-mode-select').value = 'tanggal';
  document.getElementById('docx-kata-kunci').value = '';
  document.getElementById('docx-divisi-select').value = '';
  gantiModeExportDocx();
  const hariIni = new Date().toISOString().slice(0, 10);
  const awalBulan = hariIni.slice(0, 8) + '01';
  document.getElementById('docx-dari-tanggal').value = awalBulan;
  document.getElementById('docx-sampai-tanggal').value = hariIni;
  modal.classList.add('open');
}
function closeExportDocxModal() { document.getElementById('export-docx-modal').classList.remove('open'); }
function gantiModeExportDocx() {
  const mode = document.getElementById('docx-mode-select').value;
  document.getElementById('docx-filter-tanggal').style.display = mode === 'tanggal' ? '' : 'none';
  document.getElementById('docx-filter-kata-kunci').style.display = mode === 'kata_kunci' ? '' : 'none';
}
async function exportDocx() {
  const mode = document.getElementById('docx-mode-select').value;
  const body = { mode, divisi: document.getElementById('docx-divisi-select').value };
  if (mode === 'tanggal') {
    body.dariISO = document.getElementById('docx-dari-tanggal').value;
    body.sampaiISO = document.getElementById('docx-sampai-tanggal').value;
    if (!body.dariISO || !body.sampaiISO) { alert('Isi tanggal dari dan sampai'); return; }
  } else {
    body.kataKunci = document.getElementById('docx-kata-kunci').value.trim();
    if (!body.kataKunci) { alert('Isi kata kunci'); return; }
  }
  const btn = document.getElementById('docx-export-btn');
  const btnHtmlAsli = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Membuat file...';
  try {
    const r = await fetch('/api/export-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'Gagal membuat file DOCX');
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Ringkasan-Kegiatan.docx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeExportDocxModal();
  } catch (e) {
    alert(e.message || 'Gagal membuat file DOCX');
  } finally {
    btn.disabled = false; btn.innerHTML = btnHtmlAsli;
  }
}

async function cetakPDF() {
  const bulan = document.getElementById('print-bulan-select').value;
  document.getElementById('filter-bulan').value = bulan;
  await loadData();
  closePrintModal();
  // Beri jeda sedikit supaya layout & gambar sempat selesai dirender sebelum dialog print dibuka,
  // supaya kartu tidak terpotong setengah jadi saat dicetak.
  setTimeout(() => window.print(), 250);
}

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

async function syncJurnal() {
  const btn = document.getElementById('sync-jurnal-btn');
  const asli = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Menyinkron jurnal...';
  try {
    const r = await fetch('/api/sync/jurnal', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Gagal sinkron jurnal');
    alert('Sinkron jurnal selesai!\\nFile diperiksa: ' + d.diperiksa + '\\nKegiatan baru: ' + d.ditambah + '\\nDilewati (sudah pernah diproses / tidak didukung): ' + d.dilewati);
    loadData();
  } catch (e) {
    alert('Gagal sinkron dari jurnal Drive: ' + e.message);
  } finally {
    btn.disabled = false; btn.innerHTML = asli;
  }
}

async function syncCalendar() {
  const dariISO = prompt('Sinkron kalender dari tanggal (YYYY-MM-DD):', new Date().toISOString().slice(0,8) + '01');
  if (!dariISO) return;
  const sampaiISO = prompt('Sampai tanggal (YYYY-MM-DD):', new Date().toISOString().slice(0,10));
  if (!sampaiISO) return;
  const btn = document.getElementById('sync-calendar-btn');
  const asli = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Menyinkron kalender...';
  try {
    const r = await fetch('/api/sync/calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dariISO, sampaiISO })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Gagal sinkron kalender');
    alert('Sinkron kalender selesai!\\nEvent ditemukan: ' + d.ditemukan + '\\nKegiatan baru: ' + d.ditambah + '\\nDilewati (sudah ada): ' + d.dilewati);
    loadData();
  } catch (e) {
    alert('Gagal sinkron dari Google Calendar: ' + e.message);
  } finally {
    btn.disabled = false; btn.innerHTML = asli;
  }
}

async function saveEdit() {
  const id = document.getElementById('edit-id').value;
  const judul = document.getElementById('edit-judul').value;
  const deskripsi = document.getElementById('edit-desc').value;
  const tanggalISO = document.getElementById('edit-tanggal').value;
  const divisi = document.getElementById('edit-divisi').value;
  const btn = document.querySelector('#modal .btn-save');
  const btnHtmlAsli = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    const r = await fetch('/api/kegiatan/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ judul, deskripsi, tanggalISO, divisi, fotoBase64: editFotoBase64 })
    });
    if (!r.ok) throw new Error('gagal');
    const hasil = await r.json();
    closeModal();
    loadData();
    if (hasil.fotoGagal) alert('Perubahan tersimpan, tapi foto baru gagal diupload ke Google Drive. Foto lama (jika ada) tetap dipakai — coba edit lagi untuk mengganti foto.');
  } catch (e) {
    alert('Gagal menyimpan perubahan');
  } finally {
    btn.disabled = false; btn.innerHTML = btnHtmlAsli;
  }
}
async function hapus(id) {
  if (!confirm('Hapus kegiatan ini?')) return;
  await fetch('/api/kegiatan/' + id, { method:'DELETE' });
  loadData();
}
loadData();
setInterval(loadData, 120000); // auto-refresh setiap 2 menit
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
