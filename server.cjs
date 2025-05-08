const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { URL } = require('url');
const path = require('path');
const session = require('express-session');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Konfigurasi sesi yang lebih aman untuk produksi
app.use(session({
  // Ganti 'rahasia_super_aman' dengan string acak yang panjang dan kuat.
  // Sebaiknya gunakan variabel lingkungan untuk ini di Render.
  secret: process.env.SESSION_SECRET || 'ganti_dengan_string_rahasia_yang_sangat_kuat',
  resave: false,
  // Set saveUninitialized ke false. Ini mencegah pembuatan sesi kosong
  // yang tidak perlu dan dapat membantu mematuhi beberapa hukum privasi.
  saveUninitialized: false,
  cookie: {
    // Set secure: true jika aplikasi Anda berjalan di HTTPS (umumnya di Render).
    // Ini memastikan cookie hanya dikirim melalui koneksi HTTPS.
    secure: process.env.NODE_ENV === 'production', // Otomatis true jika NODE_ENV adalah 'production'
    httpOnly: true, // Mencegah akses cookie dari JavaScript sisi klien (melindungi dari XSS)
    maxAge: 24 * 60 * 60 * 1000 // Contoh: sesi berlaku selama 1 hari (dalam milidetik)
  }
}));

// Middleware untuk memeriksa apakah pengguna sudah login
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    next(); // Pengguna sudah login, lanjutkan ke request berikutnya
  } else {
    // Pengguna belum login, arahkan ke halaman login.
    // Tambahkan parameter 'returnTo' agar setelah login bisa kembali ke halaman yang dituju.
    const returnTo = req.originalUrl;
    res.redirect(`/login.html?returnTo=${encodeURIComponent(returnTo)}`);
  }
}

// Lindungi rute-rute ini dengan middleware requireLogin
// Ini harus ditempatkan SEBELUM app.use(express.static('public'))
app.use(['/update-status.html', '/barcode-qr.html'], requireLogin);

// Sajikan file statis dari folder 'public'
// Ini harus ditempatkan SETELAH middleware proteksi rute jika rute tersebut adalah file statis.
app.use(express.static(path.join(__dirname, 'public')));


// Endpoint untuk memeriksa status autentikasi dari frontend
app.get('/check-auth', (req, res) => {
  if (req.session && req.session.loggedIn) {
    res.status(200).json({ authenticated: true });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

// Endpoint untuk proses login (menerima data via AJAX/fetch)
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  // Ganti dengan logika autentikasi yang lebih aman jika perlu (misalnya, dari database)
  if (username === 'admin' && password === '123456') {
    req.session.loggedIn = true; // Set status login di sesi
    req.session.username = username; // Opsional: simpan username di sesi
    res.json({ success: true, message: 'Login berhasil!' });
  } else {
    res.status(401).json({ success: false, message: 'Username atau password salah.' });
  }
});

// Endpoint untuk proses logout
app.get('/logout', (req, res) => {
  req.session.destroy((err) => { // Hancurkan sesi
    if (err) {
      console.error("Gagal menghancurkan sesi:", err);
      return res.status(500).send("Tidak bisa logout, coba lagi.");
    }
    res.redirect('/login.html'); // Arahkan ke halaman login setelah logout
  });
});

// Mekari HMAC credentials (pastikan ini aman dan tidak hardcode jika memungkinkan)
const HMAC_USERNAME = process.env.MEKARI_HMAC_USERNAME || 'ttEhZ8VCKPO2hZyv';
const HMAC_SECRET = process.env.MEKARI_HMAC_SECRET || 'LoYANohd7RUQeBt7aiSpIDPVxLSWf9WC';

// Fungsi untuk membuat header HMAC
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

// Endpoint untuk mengambil data invoice (POST /track)
// Middleware requireLogin bisa ditambahkan di sini jika /track juga perlu dilindungi
// app.post('/track', requireLogin, async (req, res) => {
app.post('/track', async (req, res) => {
  const transactionNo = decodeURIComponent(req.body.transaction_no);
  // Pastikan transactionNo tidak kosong atau invalid
  if (!transactionNo) {
    return res.status(400).json({ success: false, message: 'Nomor transaksi tidak boleh kosong.' });
  }
  const apiPath = `/public/jurnal/api/v1/sales_invoices/${transactionNo}`;
  const fullUrl = `https://api.mekari.com${apiPath}`;
  const { hmacHeader, dateHeader } = createHmacHeader('GET', fullUrl);

  try {
    const response = await axios.get(fullUrl, {
      headers: {
        'Authorization': hmacHeader,
        'Date': dateHeader,
        'Accept': 'application/json' // Tambahkan header Accept
      }
    });

    // Periksa apakah response.data.sales_invoice ada
    if (!response.data || !response.data.sales_invoice) {
        return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan di Mekari.' });
    }
    const invoice = response.data.sales_invoice;

    res.json({
      success: true,
      data: {
        id: invoice.id,
        transaction_no: invoice.transaction_no,
        transaction_date: invoice.transaction_date,
        due_date: invoice.due_date,
        person_id: invoice.person_id,
        person: invoice.person,
        memo: invoice.memo || '',
        ship_via: invoice.ship_via,
        transaction_lines_attributes: invoice.transaction_lines_attributes || [],
        tags: invoice.tags || []
      }
    });

  } catch (err) {
    console.error('[ERROR GET /track]', err.response?.status, err.response?.data || err.message);
    const statusCode = err.response?.status || 500;
    const errorMessage = err.response?.data?.message || err.message || 'Gagal mengambil data dari Mekari.';
    res.status(statusCode).json({
      success: false,
      message: `Gagal mengambil data: ${errorMessage}`
    });
  }
});

// Endpoint untuk update memo (PATCH /update-memo/:transaction_no)
// Middleware requireLogin harus ditambahkan di sini karena ini adalah operasi yang mengubah data
app.patch('/update-memo/:transaction_no', requireLogin, async (req, res) => {
  const transactionNo = decodeURIComponent(req.params.transaction_no);
  const { memo } = req.body;

  if (!transactionNo) {
    return res.status(400).json({ success: false, message: 'Nomor transaksi tidak boleh kosong.' });
  }
  if (typeof memo !== 'string') { // Cukup periksa tipe data, memo boleh kosong jika bisnis logic mengizinkan
    return res.status(400).json({ success: false, message: 'Memo harus berupa string.' });
  }

  const getUrl = `https://api.mekari.com/public/jurnal/api/v1/sales_invoices/${transactionNo}`;
  const { hmacHeader: getHmac, dateHeader: getDate } = createHmacHeader('GET', getUrl);

  try {
    // 1. Dapatkan data invoice terbaru untuk mendapatkan ID dan data lainnya
    const getResp = await axios.get(getUrl, {
      headers: {
        'Authorization': getHmac,
        'Date': getDate,
        'Accept': 'application/json'
      }
    });

    if (!getResp.data || !getResp.data.sales_invoice) {
      return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan untuk update.' });
    }
    const invoice = getResp.data.sales_invoice;
    const invoiceId = invoice.id; // ID invoice yang akan di-PATCH

    // 2. Siapkan payload untuk PATCH
    const patchUrl = `https://api.mekari.com/public/jurnal/api/v1/sales_invoices/${invoiceId}`;
    const { hmacHeader: patchHmac, dateHeader: patchDate } = createHmacHeader('PATCH', patchUrl);

    // Pastikan semua field yang dibutuhkan oleh API Mekari untuk PATCH sales_invoice ada di sini.
    // API Mekari mungkin memerlukan lebih banyak field daripada hanya memo.
    // Payload ini harus sesuai dengan dokumentasi API Mekari untuk PATCH Sales Invoice.
    // Seringkali, Anda perlu mengirimkan kembali banyak field dari invoice asli.
    const transactionLines = (invoice.transaction_lines_attributes || []).map(line => ({
      id: line.id, // Penting untuk update existing lines
      product_id: line.product_id || line.product?.id,
      // product_custom_id: line.product_custom_id || line.product?.custom_id, // Hati-hati jika ini tidak ada
      name: line.name || line.product?.name,
      // code: line.code || line.product?.code, // Hati-hati jika ini tidak ada
      quantity: line.quantity,
      unit_price: line.unit_price,
      // Tambahkan field lain yang diperlukan per line item jika ada
    }));

    const payload = {
      sales_invoice: {
        // Field yang biasanya diperlukan saat update (sesuaikan dengan API Mekari):
        transaction_date: invoice.transaction_date,
        due_date: invoice.due_date,
        person_id: invoice.person_id,
        // billing_address: invoice.billing_address, // Contoh field lain
        // shipping_address: invoice.shipping_address, // Contoh field lain
        // ... tambahkan field lain dari invoice yang tidak berubah ...
        transaction_lines_attributes: transactionLines,
        memo: memo // Field yang ingin diubah
      }
    };
    // Hapus field yang tidak ada atau null dari payload jika API tidak mengizinkannya
    if (payload.sales_invoice.transaction_lines_attributes) {
        payload.sales_invoice.transaction_lines_attributes.forEach(line => {
            for (const key in line) {
                if (line[key] === undefined || line[key] === null) {
                    delete line[key];
                }
            }
        });
    }


    // 3. Lakukan request PATCH
    const patchResp = await axios.patch(patchUrl, payload, {
      headers: {
        'Authorization': patchHmac,
        'Date': patchDate,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    res.json({ success: true, message: 'Memo berhasil diupdate.', data: patchResp.data });

  } catch (err) {
    console.error('[ERROR PATCH /update-memo]', err.response?.status, err.response?.config?.data , err.response?.data || err.message);
    const statusCode = err.response?.status || 500;
    const serverMessage = err.response?.data?.message || (err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : null) || err.message || 'Gagal update memo.';
    res.status(statusCode).json({
      success: false,
      message: `Gagal update memo: ${serverMessage}`,
      detail: err.response?.data // Sertakan detail error dari Mekari jika ada
    });
  }
});


// Rute fallback untuk menangani 404 (jika tidak ada rute lain yang cocok)
app.use((req, res, next) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), (err) => {
    if (err) {
      res.status(404).send("Halaman tidak ditemukan dan halaman 404.html tidak ada.");
    }
  });
});

// Middleware penanganan error global (harus paling akhir)
app.use((err, req, res, next) => {
  console.error("Terjadi error tidak terduga:", err.stack);
  res.status(500).send('Terjadi kesalahan pada server!');
});


// Jalankan server
const PORT = process.env.PORT || 3000; // Gunakan PORT dari environment variable (untuk Render)
app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  if (process.env.NODE_ENV !== 'production') {
    console.warn("Server berjalan dalam mode development. Pastikan SESSION_SECRET dan konfigurasi cookie aman untuk produksi.");
  }
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.error("PERINGATAN: SESSION_SECRET tidak diatur di environment variables! Ini tidak aman untuk produksi.");
  }
});
