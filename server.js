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

// Endpoint kiểm tra bản quyền (Dùng chung cho cả Desktop và Mobile)
app.get('/api/check-license', (req, res) => {
  const hwid = (req.query.hwid || '').trim().toUpperCase();
  const token = (req.query.token || '').trim(); // Token máy mobile gửi lên để chống dùng chung

  if (!hwid) return res.status(400).json({ active: false, message: 'Thiếu HWID' });

  const licenses = loadLicenses();
  const info = licenses[hwid];

  if (!info) {
    return res.json({ active: false, message: 'Phần mềm chưa được kích hoạt bản quyền' });
  }

  const now = Date.now();
  if (info.expireAt > now) {
    // Cơ chế chống dùng chung trên Mobile (Device Binding qua Token)
    if (token) {
      if (info.deviceToken && info.deviceToken !== token) {
        return res.json({
          active: false,
          message: 'Bản quyền này đã được kích hoạt trên một thiết bị khác! Không thể dùng chung.'
        });
      }
      // Gán token cho máy đầu tiên kích hoạt nếu chưa có
      if (!info.deviceToken) {
        info.deviceToken = token;
        licenses[hwid] = info;
        saveLicenses(licenses);
      }
    }

    return res.json({
      active: true,
      expireAt: info.expireAt,
      expireDate: new Date(info.expireAt).toLocaleString('vi-VN'),
      package: info.package,
      deviceToken: info.deviceToken || null
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

  const normalized = content.replace(/[^A-Z0-9]/g, '');
  let hwid = null;

  // 1. Nhận dạng mã máy tính cũ: HOTEL-XXXX-XXXX
  const matchDesktop = normalized.match(/HOTEL([A-Z0-9]{4})([A-Z0-9]{4})/);
  if (matchDesktop) {
    hwid = `HOTEL-${matchDesktop[1]}-${matchDesktop[2]}`;
  } else {
    // 2. Nhận dạng mã điện thoại: Số điện thoại (HOTEL09xxx) hoặc Android (HOTELANDRxxx)
    const matchMobile = normalized.match(/HOTEL([A-Z0-9]+)/);
    if (matchMobile) {
      hwid = `HOTEL-${matchMobile[1]}`;
    }
  }

  if (!hwid) {
    return res.status(400).json({ error: 'Nội dung chuyển khoản không đúng định dạng HOTEL' });
  }

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
    deviceToken: licenses[hwid] ? licenses[hwid].deviceToken : null, // Giữ token thiết bị nếu đã đăng ký
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
