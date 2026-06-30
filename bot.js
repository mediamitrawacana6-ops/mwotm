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

const DATA_FILE = './data/kegiatan.json';
if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });

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
      // readonly + file: bisa baca semua file yang sudah di-share ke service account
      // (termasuk yang diupload manual oleh admin), dan tetap bisa upload file baru.
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
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
    });

    // Buat file bisa diakses publik (read-only) supaya bisa ditampilkan di e-magazine
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
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
      { fileId, alt: 'media' },
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
  const res = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 1 });
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
    await drive.files.update({ fileId: idLama, media });
  } else {
    const fileMetadata = { name: BACKUP_FILENAME, parents: GDRIVE_FOLDER_ID ? [GDRIVE_FOLDER_ID] : undefined };
    const res = await drive.files.create({ resource: fileMetadata, media, fields: 'id' });
    backupFileId = res.data.id;
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
    const res = await drive.files.get({ fileId: idBackup, alt: 'media' }, { responseType: 'text' });
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

// ── API untuk web viewer ───────────────────────────────────
app.get('/api/kegiatan', (req, res) => {
  const bulan = req.query.bulan || '';
  let data = loadData();
  if (bulan) data = data.filter(d => d.tanggal && d.tanggal.toLowerCase().includes(bulan.toLowerCase()));
  data.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  res.json(data);
});

app.delete('/api/kegiatan/:id', async (req, res) => {
  try {
    let data = loadData();
    const item = data.find(d => d.id === req.params.id);
    if (item?.fotoDriveId) {
      const drive = getDrive();
      if (drive) await drive.files.delete({ fileId: item.fotoDriveId }).catch(()=>{});
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
    data[idx] = { ...data[idx], ...req.body };
    saveData(data);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Gagal update' }); }
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
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { font-family: 'Nunito', sans-serif; background: linear-gradient(160deg, var(--tc) 0%, var(--tc-dark) 100%) fixed; background-color: var(--tc); min-height: 100vh; }
.topbar { background: rgba(0,0,0,0.2); padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 99; }
.topbar h1 { font-family: 'Fredoka One', cursive; color: white; font-size: 1.2rem; }
.topbar input { padding: 7px 12px; border-radius: 8px; border: none; font-family:'Nunito',sans-serif; font-size: 0.88rem; background: rgba(255,255,255,0.15); color: white; outline: none; }
.btn-gen { padding: 8px 18px; background: var(--yellow); color: var(--dark); border: none; border-radius: 10px; font-weight: 800; font-size: 0.9rem; cursor: pointer; }
.mag-wrap { max-width: 820px; margin: 0 auto; padding: 0 16px 60px; }
.cover { padding: 32px 20px 20px; }
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
.btn-edit, .btn-del { padding:4px 10px; border-radius:6px; border:none; cursor:pointer; font-size:0.75rem; font-weight:700; }
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
.btn-save { padding:9px 20px; background:var(--tc); color:white; border:none; border-radius:8px; font-weight:800; cursor:pointer; }
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
  <h1>📰 E-Magazine</h1>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <input type="text" id="filter-bulan" placeholder="Filter bulan (mis: Juli 2025)" onchange="loadData()">
    <button class="btn-gen" onclick="window.print()">🖨️ Print / PDF</button>
  </div>
</div>
<div class="mag-wrap">
  <div class="cover">
    <div class="cover-title">MW ON THE MONTH</div>
    <div class="cover-month" id="cover-month">—</div>
  </div>
  <div class="timeline" id="timeline"><div class="loading">⏳ Memuat...</div></div>
  <div class="footer-bar">${ORG_NAMA} · ${FOOTER_SOCMED}</div>
</div>
<div class="modal-bg" id="modal">
  <div class="modal">
    <h3>✏️ Edit Kegiatan</h3>
    <input type="hidden" id="edit-id">
    <label>Judul</label><input type="text" id="edit-judul">
    <label>Deskripsi</label><textarea id="edit-desc"></textarea>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeModal()">Batal</button>
      <button class="btn-save" onclick="saveEdit()">💾 Simpan</button>
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
    return '<div class="tl-item"><div class="bubble"><span class="day">'+day+'</span><span class="myr">'+monthYr+'</span></div><div class="card">'+fotoHTML+'<div class="card-body"><div class="card-judul">"'+(item.judul||'Tanpa Judul')+'"</div><div class="card-desc">'+(item.deskripsi||'')+'</div><div class="card-actions"><button class="btn-edit" onclick="openEdit(\\''+item.id+'\\')">✏️ Edit</button><button class="btn-del" onclick="hapus(\\''+item.id+'\\')">🗑️ Hapus</button></div></div></div></div>';
  }).join('');
}
function openEdit(id) {
  const item = allData.find(d => d.id === id);
  if (!item) return;
  document.getElementById('edit-id').value = id;
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
async function saveEdit() {
  const id = document.getElementById('edit-id').value;
  const judul = document.getElementById('edit-judul').value;
  const deskripsi = document.getElementById('edit-desc').value;
  await fetch('/api/kegiatan/' + id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({judul, deskripsi}) });
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

restoreDataDariDrive().finally(() => {
  app.listen(PORT, () => {
    console.log(`🌐 Server aktif di port ${PORT}`);
    console.log(`📲 Webhook URL untuk Fonnte: https://<domain-kamu>/webhook/fonnte`);
  });
});
