const express = require('express');
const cors = require('cors');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(express.json());

const DB_FILE = './licenses.json';

function loadLicenses() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveLicenses(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error("Lỗi ghi licenses.json:", e);
  }
}

// Endpoint ping cho robot cron-job.org chạy 10 phút/lần chống ngủ đông
app.get('/ping', (req, res) => {
  res.send({ status: 'active', serverTime: new Date().toISOString() });
});

// Endpoint kiểm tra bản quyền từ Desktop App
app.get('/api/check-license', (req, res) => {
  const hwid = (req.query.hwid || '').trim().toUpperCase();
  if (!hwid) return res.status(400).json({ active: false, message: 'Thiếu HWID' });

  const licenses = loadLicenses();
  const info = licenses[hwid];

  if (!info) {
    return res.json({ active: false, message: 'Phần mềm chưa được kích hoạt bản quyền' });
  }

  const now = Date.now();
  if (info.expireAt > now) {
    return res.json({
      active: true,
      expireAt: info.expireAt,
      expireDate: new Date(info.expireAt).toLocaleString('vi-VN'),
      package: info.package
    });
  } else {
    return res.json({
      active: false,
      message: 'Bản quyền đã hết hạn sử dụng. Vui lòng gia hạn để tiếp tục!',
      expireAt: info.expireAt
    });
  }
});

// Webhook tiếp nhận thanh toán tự động từ SePay
app.post('/api/sepay-webhook', (req, res) => {
  const body = req.body;
  const content = (body.content || '').toUpperCase();
  const amount = parseInt(body.transferAmount || 0);

  // Chỉ nhận các giao dịch có chứa tiền tố HOTEL (không xung đột với CAFE hay BIDA)
  if (!content.includes('HOTEL')) {
    return res.json({ success: false, message: 'Giao dịch không thuộc HOTEL POS' });
  }

  // Tách HWID dạng HOTELXXXXX...
  const normalized = content.replace(/[^A-Z0-9]/g, '');
  const match = normalized.match(/HOTEL([A-Z0-9]{4})([A-Z0-9]{4})/);

  if (!match) {
    return res.status(400).json({ error: 'Nội dung chuyển khoản không đúng định dạng HWID HOTEL' });
  }

  const hwid = `HOTEL-${match[1]}-${match[2]}`;
  const now = Date.now();
  let addTimeMs = 0;
  let pkgName = '';

  // 3 Gói bản quyền theo số tiền
  if (amount >= 299000) {
    addTimeMs = 180 * 24 * 60 * 60 * 1000; // 6 tháng (180 ngày)
    pkgName = '6_THANG';
  } else if (amount >= 59000) {
    addTimeMs = 30 * 24 * 60 * 60 * 1000;  // 1 tháng (30 ngày)
    pkgName = '1_THANG';
  } else if (amount >= 2000) {
    addTimeMs = 10 * 60 * 1000;             // 10 phút dùng thử
    pkgName = '10_PHUT';
  } else {
    return res.json({ success: false, message: 'Số tiền chuyển không khớp gói bản quyền nào' });
  }

  const licenses = loadLicenses();
  const currentExpire = (licenses[hwid] && licenses[hwid].expireAt > now) ? licenses[hwid].expireAt : now;

  licenses[hwid] = {
    hwid: hwid,
    expireAt: currentExpire + addTimeMs,
    package: pkgName,
    lastPaymentAmount: amount,
    updatedAt: new Date().toISOString()
  };

  saveLicenses(licenses);
  console.log(`[HOTEL POS] Đã kích hoạt HWID: ${hwid} | Gói: ${pkgName} | Hạn mới: ${new Date(licenses[hwid].expireAt).toLocaleString('vi-VN')}`);

  return res.json({ success: true, hwid, expireAt: licenses[hwid].expireAt });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HOTEL License Server đang chạy tại cổng ${PORT}`);
});