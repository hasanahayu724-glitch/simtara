/* SIMTARA PWA — katalog siswa offline. Admin tetap di Apps Script lama.
 * Endpoint GET hanya data publik; identitas siswa lewat POST (bukan URL).
 */
'use strict';

const SIMTARA_DB = 'simtara-offline-v1';
const API_URL = String(window.SIMTARA_API_URL || '').trim();
const adaAPI = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/.test(API_URL);
const DAFTAR_FOTO_BERSAMAAN = 2;
let semuaTanaman = [];
let hasilMemuat = false;
let sedangMenyimpan = false;
let statusSinkron = 'Katalog belum dimuat.';
const cacheFotoMemori = new Map();
const memuatFoto = new Map();
let counterJSONP = 0;
let dbPromise;

function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('Browser ini tidak mendukung penyimpanan offline.'));
      return;
    }
    const req = indexedDB.open(SIMTARA_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata');
      if (!db.objectStoreNames.contains('foto')) db.createObjectStore('foto');
      if (!db.objectStoreNames.contains('antreanAkses')) db.createObjectStore('antreanAkses', { keyPath: 'rid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Database lokal gagal dibuka.'));
  });
  return dbPromise;
}

async function ambilLokal(toko, kunci) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(toko, 'readonly').objectStore(toko).get(kunci);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function simpanLokal(toko, kunci, nilai) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(toko, 'readwrite').objectStore(toko).put(nilai, kunci);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function semuaAntrean() {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('antreanAkses', 'readonly').objectStore('antreanAkses').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function tambahAntrean(data) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('antreanAkses', 'readwrite').objectStore('antreanAkses').put(data);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function hapusAntrean(rid) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('antreanAkses', 'readwrite').objectStore('antreanAkses').delete(rid);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function ubahStatus(teks) {
  statusSinkron = teks;
  const elem = document.getElementById('statusPWA');
  elem.textContent = `${navigator.onLine ? '🟢 Online' : '📴 Offline'} • ${teks}`;
}
function ubahRincian(teks) { document.getElementById('rincianOffline').textContent = teks; }
function infoKosong(judul, pesan, ulang = false) {
  const daftar = document.getElementById('daftar');
  daftar.replaceChildren();
  const box = document.createElement('div');
  box.className = 'empty-state';
  const ikon = document.createElement('div'); ikon.className = 'empty-icon'; ikon.textContent = ulang ? '⚠️' : '🌱';
  const h = document.createElement('h3'); h.textContent = judul;
  const p = document.createElement('p'); p.textContent = pesan;
  box.append(ikon, h, p);
  if (ulang) {
    const tombol = document.createElement('button'); tombol.className = 'retry';
    tombol.textContent = 'Coba Lagi'; tombol.addEventListener('click', perbaruiKatalog);
    box.appendChild(tombol);
  }
  daftar.appendChild(box);
}
function bersihkanDaftar(data) {
  return (Array.isArray(data) ? data : [])
    .filter(x => x && x.nama && x.id)
    .map(x => ({
      id: String(x.id), nama: String(x.nama || ''), kelas: String(x.kelas || ''),
      namaIlmiah: String(x.namaIlmiah || ''), lokasi: String(x.lokasi || ''),
      jumlah: Number(x.jumlah || 0), ciri: String(x.ciri || ''),
      klasifikasi: String(x.klasifikasi || ''), diubahPada: String(x.diubahPada || ''), punyaFoto: Boolean(x.punyaFoto)
    }))
    .sort((a,b) => a.nama.localeCompare(b.nama, 'id'));
}

// Apps Script ContentService tidak bisa dipakai dengan google.script.run di domain PWA.
// JSONP hanya untuk membaca katalog/foto PUBLIK dan mengecek tanda penerimaan.
function apiJSONP(api, params = {}, timeoutMs = 35000) {
  if (!adaAPI) return Promise.reject(new Error('URL API Google Apps Script belum diisi dalam config.js.'));
  return new Promise((resolve, reject) => {
    const callback = '__simtaraCb' + Date.now() + '_' + (++counterJSONP);
    const url = new URL(API_URL);
    url.searchParams.set('api', api);
    url.searchParams.set('callback', callback);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, String(v)));
    const script = document.createElement('script');
    script.async = true; script.src = url.toString(); script.referrerPolicy = 'no-referrer';
    let selesai = false;
    let timer;
    function akhir(err, data) {
      if (selesai) return;
      selesai = true; clearTimeout(timer); script.remove();
      delete window[callback];
      if (err) reject(err); else if (!data || data.ok !== true) reject(new Error((data && data.error) || 'Respons server tidak valid.'));
      else resolve(data);
    }
    window[callback] = value => akhir(null, value);
    script.onerror = () => akhir(new Error('Gagal menghubungi Apps Script. Cek link deployment dan koneksi.'));
    timer = setTimeout(() => akhir(new Error('Server terlalu lama merespons.')), timeoutMs);
    document.head.appendChild(script);
  });
}

function buatFilterKelas() {
  const select = document.getElementById('filterKelas');
  const sebelumnya = select.value;
  select.replaceChildren();
  const semua = document.createElement('option'); semua.value = ''; semua.textContent = 'Semua kelas';
  select.appendChild(semua);
  const daftar = [...new Set(semuaTanaman.map(item => item.kelas.trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'id'));
  daftar.forEach(kelas => {
    const opt = document.createElement('option'); opt.value = kelas; opt.textContent = kelas;
    select.appendChild(opt);
  });
  select.value = daftar.includes(sebelumnya) ? sebelumnya : '';
}
function tambahBarisDetail(kotak, label, nilai) {
  const isi = String(nilai == null ? '' : nilai).trim();
  if (!isi) return;
  const row = document.createElement('div'); row.className = 'plant-detail-row';
  const lbl = document.createElement('span'); lbl.className = 'plant-detail-label'; lbl.textContent = label;
  const teks = document.createElement('div'); teks.className = 'plant-detail-value'; teks.textContent = isi;
  row.append(lbl,teks); kotak.appendChild(row);
}

const pengamatFoto = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  entries.forEach(entri => {
    if (!entri.isIntersecting) return;
    pengamatFoto.unobserve(entri.target);
    const tanaman = entri.target._tanaman;
    if (tanaman) tampilkanFoto(tanaman, entri.target);
  });
}, {rootMargin:'300px'}) : null;

function tampilkanTanaman() {
  const key = document.getElementById('cari').value.trim().toLowerCase();
  const kelas = document.getElementById('filterKelas').value;
  const hasil = semuaTanaman.filter(x => {
    const gabungan=[x.nama,x.namaIlmiah,x.kelas,x.lokasi,x.ciri,x.klasifikasi].join(' ').toLowerCase();
    return gabungan.includes(key) && (!kelas || x.kelas===kelas);
  });
  document.getElementById('jumlah').textContent = hasil.length+' Tanaman';
  const daftar=document.getElementById('daftar');
  daftar.replaceChildren();
  if (!hasil.length) {
    infoKosong(semuaTanaman.length ? 'Tanaman tidak ditemukan' : 'Belum ada tanaman',
      semuaTanaman.length ? 'Coba kata kunci lain atau ubah filter kelas.' : 'Katalog belum memiliki data yang tersimpan di HP ini.');
    return;
  }
  const fragment=document.createDocumentFragment();
  hasil.forEach((item, index) => {
    const card=document.createElement('article'); card.className='plant-card';
    const foto=document.createElement('div'); foto.className='plant-photo'; foto._tanaman=item;
    card.appendChild(foto);
    const isi=document.createElement('div'); isi.className='plant-content';
    const top=document.createElement('div'); top.className='plant-top';
    const nomor=document.createElement('span'); nomor.className='plant-number';
    nomor.textContent='TANAMAN #'+String(index+1).padStart(2,'0'); top.appendChild(nomor); isi.appendChild(top);
    const nama=document.createElement('h3'); nama.className='plant-name'; nama.textContent=item.nama; isi.appendChild(nama);
    if (item.namaIlmiah) {
      const ilmiah=document.createElement('div'); ilmiah.className='plant-scientific';
      ilmiah.textContent=item.namaIlmiah; isi.appendChild(ilmiah);
    }
    const cls=document.createElement('span'); cls.className='plant-class'; cls.textContent='Kelas: '+(item.kelas||'-'); isi.appendChild(cls);
    if (item.lokasi) {
      const lokasi=document.createElement('div'); lokasi.className='plant-location'; lokasi.textContent='📍 '+item.lokasi;
      isi.appendChild(lokasi);
    }
    const rincian=document.createElement('details'); rincian.className='plant-details';
    const summary=document.createElement('summary'); summary.textContent='Lihat informasi lengkap'; rincian.appendChild(summary);
    const list=document.createElement('div'); list.className='plant-detail-list';
    tambahBarisDetail(list,'Nama ilmiah',item.namaIlmiah);
    tambahBarisDetail(list,'Klasifikasi',item.klasifikasi);
    tambahBarisDetail(list,'Ciri morfologi',item.ciri);
    tambahBarisDetail(list,'Lokasi',item.lokasi);
    if (item.jumlah != null) tambahBarisDetail(list,'Jumlah tanaman',String(item.jumlah));
    if (!list.children.length) tambahBarisDetail(list,'Informasi','Detail tanaman belum dilengkapi.');
    rincian.appendChild(list); isi.appendChild(rincian); card.appendChild(isi);
    fragment.appendChild(card);
  });
  daftar.appendChild(fragment);
  [...daftar.querySelectorAll('.plant-photo')].forEach(foto => {
    if (pengamatFoto) pengamatFoto.observe(foto);
    else tampilkanFoto(foto._tanaman, foto);
  });
}

async function dapatFoto(item) {
  const id=item.id;
  const kunciFoto = id + '__' + (item.diubahPada || 'awal');
  if (cacheFotoMemori.has(kunciFoto)) return cacheFotoMemori.get(kunciFoto);
  if (memuatFoto.has(kunciFoto)) return memuatFoto.get(kunciFoto);
  const proses=(async()=>{
    let local;
    try { local=await ambilLokal('foto',kunciFoto); } catch (err) { console.warn(err); }
    if (local && /^data:image\/(?:jpeg|png|webp);base64,/.test(local)) {
      cacheFotoMemori.set(kunciFoto,local); return local;
    }
    if (!navigator.onLine || !adaAPI || !item.punyaFoto) return null;
    const res=await apiJSONP('foto',{id},45000);
    const src=res.foto;
    if (!src || !/^data:image\/(?:jpeg|png|webp);base64,/.test(src)) return null;
    cacheFotoMemori.set(kunciFoto,src);
    try { await simpanLokal('foto',kunciFoto,src); }
    catch(err) { console.warn('Foto tidak dapat disimpan lokal:', err); }
    return src;
  })().finally(()=>memuatFoto.delete(kunciFoto));
  memuatFoto.set(kunciFoto,proses);
  return proses;
}
async function tampilkanFoto(item, tempat) {
  if (!tempat || !tempat.isConnected || tempat.childElementCount>0) return;
  const placeholder=document.createElement('div'); placeholder.className='foto-placeholder';
  placeholder.textContent='🌿';
  const sub=document.createElement('small');
  sub.textContent=item.punyaFoto?'Memuat foto...':'Belum ada foto'; placeholder.appendChild(sub);
  tempat.appendChild(placeholder);
  if (!item.punyaFoto) return;
  try {
    const src=await dapatFoto(item);
    if (!tempat.isConnected) return;
    if (!src) { sub.textContent = navigator.onLine ? 'Foto belum tersedia' : 'Foto belum disimpan offline'; return; }
    const gambar=new Image(); gambar.alt='Foto tanaman '+item.nama; gambar.loading='lazy'; gambar.decoding='async';
    gambar.onload=()=>{if(tempat.isConnected) tempat.replaceChildren(gambar);};
    gambar.onerror=()=>{ sub.textContent='Gagal menampilkan foto'; };
    gambar.src=src;
  } catch(err) { sub.textContent = navigator.onLine?'Foto gagal dimuat':'Foto belum tersimpan offline'; }
}

async function perbaruiKatalog() {
  if (hasilMemuat) return;
  if (!navigator.onLine) { ubahStatus('Sedang offline, menampilkan data yang terakhir disimpan.'); return; }
  if (!adaAPI) { ubahStatus('Belum terhubung: isi URL /exec pada config.js terlebih dahulu.'); return; }
  hasilMemuat=true;
  document.getElementById('tombolPerbarui').disabled=true;
  ubahStatus('Mengambil data tanaman terbaru...');
  try {
    const res=await apiJSONP('katalog');
    const data=bersihkanDaftar(res.data);
    // Simpan lokal dulu, baru terapkan. Data lama tidak hilang bila jaringan gagal.
    await simpanLokal('metadata','katalog',{data, diunduhPada:new Date().toISOString()});
    semuaTanaman=data;
    buatFilterKelas(); tampilkanTanaman();
    ubahStatus(`${data.length} tanaman siap diakses tanpa internet (teks).`);
    ubahRincian('Untuk menyimpan semua foto ke HP, tekan "Simpan untuk offline" ketika internet aktif. Data diperbarui terakhir: '+new Date().toLocaleString('id-ID'));
    // Coba kirim kunjungan tertunda setiap kali berhasil terkoneksi.
    sinkronKunjungan().catch(console.warn);
  } catch(err) {
    ubahStatus('Gagal memperbarui: '+err.message);
    if (!semuaTanaman.length) infoKosong('Katalog belum dapat dimuat',err.message,true);
  } finally {
    hasilMemuat=false;
    document.getElementById('tombolPerbarui').disabled=false;
  }
}

async function unduhUntukOffline() {
  if (sedangMenyimpan) return;
  if (!navigator.onLine) { ubahStatus('Aktifkan internet untuk mengunduh foto tanaman.'); return; }
  if (!adaAPI) { ubahStatus('Isi URL API pada config.js terlebih dahulu.'); return; }
  sedangMenyimpan=true;
  const btn=document.getElementById('tombolUnduh'); btn.disabled=true;
  try {
    // Ambil versi terbaru data sebelum menyimpan seluruh foto.
    await perbaruiKatalog();
    const daftar=semuaTanaman.filter(x=>x.punyaFoto);
    let selesai=0, tersedia=0, gagal=0, next=0;
    async function pekerja() {
      while(next<daftar.length) {
        const item=daftar[next++];
        try { const src=await dapatFoto(item); if (src) tersedia++; else gagal++; }
        catch(err) { gagal++; }
        selesai++;
        ubahStatus(`Menyimpan foto ${selesai}/${daftar.length}...`);
      }
    }
    await Promise.all(Array.from({length:Math.min(DAFTAR_FOTO_BERSAMAAN,daftar.length)},()=>pekerja()));
    ubahStatus(`Selesai: ${semuaTanaman.length} data tanaman, ${tersedia} foto tersedia offline${gagal ? ', '+gagal+' foto gagal disimpan' : ''}.`);
    ubahRincian('Uji dengan mematikan internet lalu membuka kembali ikon SIMTARA. Jika foto gagal, coba tekan tombol ini lagi saat online.');
    tampilkanTanaman();
  } catch(err) { ubahStatus('Gagal menyimpan: '+err.message); }
  finally {sedangMenyimpan=false;btn.disabled=false;}
}

function buatRid() {
  if (window.crypto && typeof crypto.randomUUID==='function') return crypto.randomUUID().replaceAll('-','');
  const arr=new Uint8Array(20); crypto.getRandomValues(arr);
  return [...arr].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function catatKunjungan(e) {
  e.preventDefault();
  const nama=document.getElementById('namaPengunjung').value.trim();
  const kelas=document.getElementById('kelasPengunjung').value.trim();
  const pesan=document.getElementById('pesanAkses');
  const tombol=document.getElementById('tombolMasukKatalog');
  if (!nama || !kelas) {pesan.textContent='Nama/kode dan kelas wajib diisi.';return;}
  if (/^[=+\-@]/.test(nama) || /^[=+\-@]/.test(kelas)) {pesan.textContent='Format nama/kode atau kelas tidak valid.';return;}
  tombol.disabled=true;
  tombol.textContent='Menyiapkan katalog...';
  pesan.textContent='';
  try {
    // Identitas disimpan sementara di perangkat hingga dikonfirmasi oleh server.
    await tambahAntrean({rid:buatRid(), nama, kelas, dibuatPada:new Date().toISOString()});
    document.body.classList.add('aksesDisetujui');
    document.getElementById('layarAksesSiswa').remove();
    if(navigator.onLine) sinkronKunjungan().catch(console.warn);
  } catch(err) {
    pesan.textContent='Tidak bisa menyimpan catatan akses di perangkat: '+err.message;
  } finally {
    tombol.disabled=false;
    tombol.textContent='🌱 Masuk Katalog';
  }
}

let sinkronAktif=false;
async function sinkronKunjungan() {
  if (sinkronAktif || !navigator.onLine || !adaAPI) return;
  sinkronAktif=true;
  try {
    const antrean=await semuaAntrean();
    for (const entri of antrean) {
      // Periksa apakah server sudah menerima kiriman sebelumnya.
      let tanda=await apiJSONP('cekAkses',{rid:entri.rid});
      if (!tanda.tercatat) {
        // Mode no-cors untuk POST sederhana ke Apps Script; status respons
        // opaque, maka WAJIB konfirmasi terpisah sebelum menghapus antrean.
        await fetch(API_URL, {
          method:'POST',mode:'no-cors',credentials:'omit',redirect:'follow',
          headers:{'Content-Type':'text/plain;charset=UTF-8'},
          body:JSON.stringify({aksi:'catatAksesPWA',rid:entri.rid,nama:entri.nama,kelas:entri.kelas})
        });
        tanda=await apiJSONP('cekAkses',{rid:entri.rid});
      }
      if(tanda.tercatat) await hapusAntrean(entri.rid);
      else break; // Biarkan antrean sampai konfirmasi berikutnya.
    }
  } catch(err) {console.warn('Kunjungan belum dapat disinkronkan:',err.message);}
  finally {sinkronAktif=false;}
}

async function mula() {
  document.getElementById('cari').addEventListener('input',tampilkanTanaman);
  document.getElementById('filterKelas').addEventListener('change',tampilkanTanaman);
  document.getElementById('tombolPerbarui').addEventListener('click',perbaruiKatalog);
  document.getElementById('tombolUnduh').addEventListener('click',unduhUntukOffline);
  document.getElementById('formAksesSiswa').addEventListener('submit',catatKunjungan);
  window.addEventListener('online',()=>{ubahStatus('Internet tersambung kembali.');perbaruiKatalog();sinkronKunjungan();});
  window.addEventListener('offline',()=>ubahStatus('Mode offline aktif: data tersimpan tetap bisa dicari.'));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('PWA tidak dapat didaftarkan:',err));
  }
  try {
    const saved=await ambilLokal('metadata','katalog');
    if(saved && Array.isArray(saved.data)) {
      semuaTanaman=bersihkanDaftar(saved.data);
      buatFilterKelas();tampilkanTanaman();
      const kapan = saved.diunduhPada ? new Date(saved.diunduhPada).toLocaleString('id-ID') : 'tidak diketahui';
      ubahStatus(`${semuaTanaman.length} tanaman tersedia di HP (data ${kapan}).`);
      ubahRincian('Katalog tersimpan dapat dibuka offline. Foto hanya akan tampil offline jika pernah tersimpan di perangkat.');
    } else {
      infoKosong('Belum ada katalog offline','Hubungkan internet dan perbarui katalog untuk pertama kali.');
      ubahStatus('Belum ada data yang tersimpan di HP.');
    }
  } catch(err) {infoKosong('Penyimpanan offline belum tersedia',err.message);ubahStatus(err.message);}
  if(navigator.onLine) {
    if(adaAPI) {perbaruiKatalog();sinkronKunjungan();}
    else ubahStatus('Isi URL deployment Apps Script pada config.js agar katalog aktif.');
  }
}
document.addEventListener('DOMContentLoaded',mula);
