const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { URL } = require('url');
const app = express();

app.use(express.json());
app.use(express.static('public'));

app.post('/track', async (req, res) => {
  const transactionNo = decodeURIComponent(req.body.transaction_no);
  const path = `/public/jurnal/api/v1/sales_invoices/${transactionNo}`;
  const fullUrl = `https://api.mekari.com${path}`;
  const method = 'GET';
  const httpVersion = 'HTTP/1.1';

  const urlObj = new URL(fullUrl);
  const requestLine = `${method} ${urlObj.pathname}${urlObj.search} ${httpVersion}`;

  const dateHeader = new Date().toUTCString();
  const stringToSign = `date: ${dateHeader}\n${requestLine}`;

  const hmac_username = 'ttEhZ8VCKPO2hZyv';
  const hmac_secret = 'LoYANohd7RUQeBt7aiSpIDPVxLSWf9WC';

  const signature = crypto
    .createHmac('sha256', hmac_secret)
    .update(stringToSign, 'utf8')
    .digest('base64');

  const hmacHeader = `hmac username="${hmac_username}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`;

  console.log('[DEBUG] StringToSign:', stringToSign);
  console.log('[DEBUG] Authorization:', hmacHeader);
  console.log('[DEBUG] Date:', dateHeader);
  console.log('[DEBUG] Full URL:', fullUrl);

  try {
    const response = await axios.get(fullUrl, {
      headers: {
        'Authorization': hmacHeader,
        'Date': dateHeader
      }
    });

    const invoice = response.data.sales_invoice;

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Transaksi tidak ditemukan.'
      });
    }

    res.json({
      success: true,
      data: {
        display_name: invoice.person?.display_name,
        product: invoice.product?.name,
        transaction_date: invoice.transaction_date,
        quantity: invoice.transaction_lines_attributes?.[0]?.quantity ?? 0
      }
    });
  } catch (err) {
    console.error('[ERROR]', err.response?.status, err.response?.headers);
    console.error('[ERROR DATA]', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: 'API Jurnal gagal: ' + (err.response?.data?.message || err.message)
    });
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});
