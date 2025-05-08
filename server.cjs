const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { URL } = require('url');
const path = require('path');
const session = require('express-session');

const app = express();

// Middleware untuk parsing JSON dan URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PENTING: Percayai reverse proxy (Render menggunakan proxy)
// Ini harus diset SEBELUM app.use(session(...))
// Ini membantu cookie 'secure: true' bekerja dengan benar di belakang proxy.
app.set('trust proxy', 1); // Angka 1 berarti percaya pada 1 hop proxy

// Konfigurasi sesi
app.use(session({
  secret: process.env.SESSION_SECRET || 'ganti_dengan_string_rahasia_yang_sangat_kuat_dan_unik',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 1 hari
    path: '/' // Pastikan path cookie adalah root
    // domain: process.env.NODE_ENV === 'production' ? '.onrender.com' : undefined, // Jarang diperlukan, coba tanpa ini dulu
  }
}));

// Middleware untuk memeriksa apakah pengguna sudah login
function requireLogin(req, res, next) {
  console.log(`[RequireLogin] Session ID: ${req.sessionID}, LoggedIn: ${req.session.loggedIn}`);
  console.log(`[RequireLogin] Mencoba mengakses: ${req.originalUrl}`);
  if (req.session && req.session.loggedIn) {
    next();
  } else {
    const returnTo = req.originalUrl;
    console.log(`[RequireLogin] Belum login. Mengarahkan ke login dengan returnTo: ${returnTo}`);
    res.redirect(`/login.html?returnTo=${encodeURIComponent(returnTo)}`);
  }
}

// Lindungi rute-rute ini
app.use(['/update-status.html', '/barcode-qr.html'], requireLogin);

// Sajikan file statis dari folder 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint untuk memeriksa status autentikasi
app.get('/check-auth', (req, res) => {
  if (req.session && req.session.loggedIn) {
    res.status(200).json({ authenticated: true, username: req.session.username });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

// Endpoint untuk proses login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  console.log(`[POST /login] Mencoba login dengan username: ${username}`);
  if (username === 'admin' && password === '123456') { // Ganti dengan logika autentikasi yang aman
    req.session.loggedIn = true;
    req.session.username = username;
    // Penting untuk menyimpan sesi secara eksplisit jika ada modifikasi sebelum redirect/response
    req.session.save(err => {
        if (err) {
            console.error('[POST /login] Gagal menyimpan sesi:', err);
            return res.status(500).json({ success: false, message: 'Terjadi kesalahan server saat login.' });
        }
        console.log(`[POST /login] Login berhasil untuk ${username}. Session ID: ${req.sessionID}, Sesi:`, req.session);
        res.json({ success: true, message: 'Login berhasil!' });
    });
  } else {
    console.log(`[POST /login] Login gagal untuk username: ${username}`);
    res.status(401).json({ success: false, message: 'Username atau password salah.' });
  }
});

// Endpoint untuk proses logout
app.get('/logout', (req, res) => {
  const username = req.session.username;
  console.log(`[GET /logout] Mencoba logout untuk user: ${username}`);
  req.session.destroy((err) => {
    if (err) {
      console.error(`[GET /logout] Gagal menghancurkan sesi untuk ${username}:`, err);
      return res.status(500).send("Tidak bisa logout, coba lagi.");
    }
    console.log(`[GET /logout] Sesi berhasil dihancurkan untuk ${username}. Mengarahkan ke login.`);
    res.clearCookie('connect.sid', { path: '/' }); // Nama cookie default adalah 'connect.sid'
    res.redirect('/login.html');
  });
});

// --- Endpoint API Mekari Anda (tidak diubah, hanya diringkas untuk brevity) ---
const HMAC_USERNAME = process.env.MEKARI_HMAC_USERNAME || 'ttEhZ8VCKPO2hZyv';
const HMAC_SECRET = process.env.MEKARI_HMAC_SECRET || 'LoYANohd7RUQeBt7aiSpIDPVxLSWf9WC';

function createHmacHeader(method, url) {
  const urlObj = new URL(url);
  const requestLine = `${method.toUpperCase()} ${urlObj.pathname}${urlObj.search} HTTP/1.1`;
  const dateHeader = new Date().toUTCString();
  const stringToSign = `date: ${dateHeader}\n${requestLine}`;
  const signature = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(stringToSign, 'utf8')
    .digest('base64');
  const hmacHeader = `hmac username="${HMAC_USERNAME}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`;
  return { hmacHeader, dateHeader };
}

app.post('/track', async (req, res) => {
  const transactionNo = decodeURIComponent(req.body.transaction_no);
  if (!transactionNo) {
    return res.status(400).json({ success: false, message: 'Nomor transaksi tidak boleh kosong.' });
  }
  const apiPath = `/public/jurnal/api/v1/sales_invoices/${transactionNo}`;
  const fullUrl = `https://api.mekari.com${apiPath}`;
  const { hmacHeader, dateHeader } = createHmacHeader('GET', fullUrl);
  console.log(`[POST /track] Melacak transaksi: ${transactionNo}`);
  try {
    const response = await axios.get(fullUrl, { headers: { 'Authorization': hmacHeader, 'Date': dateHeader, 'Accept': 'application/json' } });
    if (!response.data || !response.data.sales_invoice) {
        console.warn(`[POST /track] Invoice tidak ditemukan di Mekari untuk ${transactionNo}`);
        return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan di Mekari.' });
    }
    res.json({ success: true, data: response.data.sales_invoice });
  } catch (err) {
    console.error(`[ERROR POST /track] Transaksi ${transactionNo}:`, err.response?.status, err.response?.data || err.message);
    const statusCode = err.response?.status || 500;
    const errorMessage = err.response?.data?.message || err.message || 'Gagal mengambil data dari Mekari.';
    res.status(statusCode).json({ success: false, message: `Gagal mengambil data: ${errorMessage}` });
  }
});

app.patch('/update-memo/:transaction_no', requireLogin, async (req, res) => {
  const transactionNo = decodeURIComponent(req.params.transaction_no);
  const { memo } = req.body;
  console.log(`[PATCH /update-memo] User ${req.session.username} mengupdate memo untuk ${transactionNo} menjadi "${memo}"`);
  // ... (logika PATCH Anda, pastikan ada logging error yang baik di dalamnya) ...
  // Contoh singkat:
  if (typeof memo !== 'string') {
    return res.status(400).json({ success: false, message: 'Memo harus berupa string.' });
  }
  // Implementasi lengkap Anda di sini...
  // Dummy response untuk contoh
  // res.json({ success: true, message: 'Memo berhasil diupdate (implementasi patch belum lengkap).' });

  // Implementasi dari sebelumnya (pastikan sudah benar)
  const getUrl = `https://api.mekari.com/public/jurnal/api/v1/sales_invoices/${transactionNo}`;
  const { hmacHeader: getHmac, dateHeader: getDate } = createHmacHeader('GET', getUrl);

  try {
    const getResp = await axios.get(getUrl, { headers: { 'Authorization': getHmac, 'Date': getDate, 'Accept': 'application/json' } });
    if (!getResp.data || !getResp.data.sales_invoice) {
      return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan untuk update.' });
    }
    const invoice = getResp.data.sales_invoice;
    const invoiceId = invoice.id;
    const patchUrl = `https://api.mekari.com/public/jurnal/api/v1/sales_invoices/${invoiceId}`;
    const { hmacHeader: patchHmac, dateHeader: patchDate } = createHmacHeader('PATCH', patchUrl);
    const transactionLines = (invoice.transaction_lines_attributes || []).map(line => ({
      id: line.id, product_id: line.product_id || line.product?.id, name: line.name || line.product?.name,
      quantity: line.quantity, unit_price: line.unit_price,
    }));
    const payload = {
      sales_invoice: {
        transaction_date: invoice.transaction_date, due_date: invoice.due_date, person_id: invoice.person_id,
        transaction_lines_attributes: transactionLines, memo: memo
      }
    };
    // Hapus field undefined/null dari payload jika API tidak mengizinkannya
     if (payload.sales_invoice.transaction_lines_attributes) {
        payload.sales_invoice.transaction_lines_attributes.forEach(line => {
            for (const key in line) { if (line[key] === undefined || line[key] === null) { delete line[key]; } }
        });
    }

    const patchResp = await axios.patch(patchUrl, payload, {
      headers: { 'Authorization': patchHmac, 'Date': patchDate, 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
    console.log(`[PATCH /update-memo] Memo berhasil diupdate untuk ${transactionNo}`);
    res.json({ success: true, message: 'Memo berhasil diupdate.', data: patchResp.data });
  } catch (err) {
    console.error(`[ERROR PATCH /update-memo] Transaksi ${transactionNo}:`, err.response?.status, err.response?.config?.data, err.response?.data || err.message);
    const statusCode = err.response?.status || 500;
    const serverMessage = err.response?.data?.message || (err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : null) || err.message || 'Gagal update memo.';
    res.status(statusCode).json({ success: false, message: `Gagal update memo: ${serverMessage}`, detail: err.response?.data });
  }
});
// --- Akhir Endpoint API Mekari ---

// Rute fallback untuk 404
app.use((req, res, next) => {
  console.warn(`[404 Not Found] Rute tidak ditemukan: ${req.method} ${req.originalUrl}`);
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), (err) => {
    if (err) {
      res.status(404).send("Halaman tidak ditemukan dan file 404.html tidak ada di folder public.");
    }
  });
});

// Middleware penanganan error global
app.use((err, req, res, next) => {
  console.error("[Global Error Handler] Terjadi error tidak terduga:", err);
  res.status(500).send('Terjadi kesalahan pada server!');
});

// Jalankan server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
  if (process.env.NODE_ENV !== 'production') {
    console.warn("PERINGATAN: Server berjalan dalam mode development.");
  }
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.error("KRITIS: SESSION_SECRET tidak diatur di environment variables! Ini TIDAK AMAN untuk produksi.");
  }
});
