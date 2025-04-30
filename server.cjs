const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { URL } = require('url');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.static('public')); // Folder untuk frontend HTML

// Mekari HMAC credentials
const HMAC_USERNAME = 'ttEhZ8VCKPO2hZyv';
const HMAC_SECRET = 'LoYANohd7RUQeBt7aiSpIDPVxLSWf9WC';

// HMAC Helper
function createHmacHeader(method, url) {
  const urlObj = new URL(url);
  const requestLine = `${method} ${urlObj.pathname}${urlObj.search} HTTP/1.1`;
  const dateHeader = new Date().toUTCString();
  const stringToSign = `date: ${dateHeader}\n${requestLine}`;
  const signature = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(stringToSign, 'utf8')
    .digest('base64');
  const hmacHeader = `hmac username="${HMAC_USERNAME}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`;
  return { hmacHeader, dateHeader };
}

// POST /track → Ambil data invoice
app.post('/track', async (req, res) => {
  const transactionNo = decodeURIComponent(req.body.transaction_no);
  const apiPath = `/public/jurnal/api/v1/sales_invoices/${transactionNo}`;
  const fullUrl = `https://api.mekari.com${apiPath}`;
  const { hmacHeader, dateHeader } = createHmacHeader('GET', fullUrl);

  try {
    const response = await axios.get(fullUrl, {
      headers: {
        Authorization: hmacHeader,
        Date: dateHeader
      }
    });

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
    console.error('[ERROR GET]', err.response?.status, err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: 'Gagal mengambil data: ' + (err.response?.data?.message || err.message)
    });
  }
});

// PATCH /update-memo/:transaction_no
app.patch('/update-memo/:transaction_no', async (req, res) => {
  const transactionNo = decodeURIComponent(req.params.transaction_no);
  const { memo } = req.body;

  if (!memo || typeof memo !== 'string') {
    return res.status(400).json({ success: false, message: 'Memo tidak boleh kosong.' });
  }

  const getUrl = `https://api.mekari.com/public/jurnal/api/v1/sales_invoices/${transactionNo}`;
  const { hmacHeader: getHmac, dateHeader: getDate } = createHmacHeader('GET', getUrl);

  try {
    // Ambil invoice detail lengkap
    const getResp = await axios.get(getUrl, {
      headers: {
        Authorization: getHmac,
        Date: getDate
      }
    });

    const invoice = getResp.data.sales_invoice;
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice tidak ditemukan.' });
    }

    const invoiceId = invoice.id;
    const patchUrl = `https://api.mekari.com/public/jurnal/api/v1/sales_invoices/${invoiceId}`;
    const { hmacHeader: patchHmac, dateHeader: patchDate } = createHmacHeader('PATCH', patchUrl);

    // Perbaiki transaction_lines_attributes untuk sertakan identifikasi produk
    const transactionLines = invoice.transaction_lines_attributes.map(line => ({
      id: line.id, // Pastikan ID line disertakan
      product_id: line.product_id || line.product?.id, // Ambil product_id dari nested object jika ada
      product_custom_id: line.product_custom_id || line.product?.custom_id,
      name: line.name || line.product?.name,
      code: line.code || line.product?.code,
      quantity: line.quantity,
      unit_price: line.unit_price,
      // Sertakan field lain yang diperlukan
    }));

    // Siapkan payload lengkap dengan transaction_lines yang telah diperbaiki
    const payload = {
      sales_invoice: {
        transaction_date: invoice.transaction_date,
        due_date: invoice.due_date,
        person_id: invoice.person_id,
        transaction_lines_attributes: transactionLines,
        memo: memo
      }
    };

    const patchResp = await axios.patch(patchUrl, payload, {
      headers: {
        Authorization: patchHmac,
        Date: patchDate,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });

    res.json({ success: true, message: 'Memo berhasil diupdate.', data: patchResp.data });

  } catch (err) {
    console.error('[ERROR PATCH]', err.response?.status, err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: 'Gagal update memo: ' + (err.response?.data?.message || err.message),
      detail: err.response?.data
    });
  }
});

// Jalankan server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
