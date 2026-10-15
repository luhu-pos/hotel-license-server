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

// Endpoint ping chống ngủ đông cho Render
app.get('/ping', (req, res) => {
  res.send({ status: 'active', serverTime: new Date().toISOString() });
});

// Endpoint kiểm tra bản quyền & Xử lý chuyển đổi trình duyệt kèm xác thực PIN
app.get('/api/check-license', (req, res) => {
  let hwid = (req.query.hwid || '').trim().toUpperCase();
  const token = (req.query.token || '').trim();
  const pin = (req.query.pin || '').trim(); // Mã PIN 4 số gửi từ máy khách

  if (!hwid) return res.status(400).json({ active: false, message: 'Thiếu HWID' });

  const licenses = loadLicenses();
  let info = licenses[hwid];
  if (!info) {
    const altHwid = hwid.replace(/-/g, '');
    info = licenses[altHwid];
    if (info) hwid = altHwid;
  }

  if (!info) {
    return res.json({ active: false, message: 'Phần mềm chưa được kích hoạt bản quyền' });
  }

  const now = Date.now();
  if (info.expireAt <= now) {
    return res.json({
      active: false,
      message: 'Bản quyền đã hết hạn sử dụng. Vui lòng gia hạn để tiếp tục!',
      expireAt: info.expireAt
    });
  }

  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Kiểm tra & Xử lý trường hợp đổi thiết bị / trình duyệt (Chrome, Safari, Cốc Cốc, Zalo...)
  if (token && hwid.startsWith('HOTEL-0')) {
    if (info.deviceToken && info.deviceToken !== token) {
      // 1. Kiểm tra mã PIN Quản trị (Mặc định: 1234 nếu chưa đổi)
      const correctPin = info.adminPin || "1234";
      if (!pin || pin !== correctPin) {
        return res.json({
          active: false,
          isKicked: true,
          requirePin: true,
          message: 'Mã PIN quản trị không đúng! Vui lòng nhập đúng PIN 4 số để chuyển thiết bị.'
        });
      }

      // 2. Reset số lượt đổi nếu sang ngày mới
      if (info.lastSwitchDate !== todayStr) {
        info.switchCountToday = 0;
        info.lastSwitchDate = todayStr;
      }

      // 3. Giới hạn: Tối đa 5 lần đổi trong 1 ngày
      const MAX_SWITCH_PER_DAY = 5;
      if ((info.switchCountToday || 0) >= MAX_SWITCH_PER_DAY) {
        return res.json({
          active: false,
          isKicked: true,
          message: 'Bạn đã đổi thiết bị quá 5 lần hôm nay. Vui lòng quay lại vào ngày mai!'
        });
      }

      // 4. Giới hạn: Mỗi lần đổi cách nhau tối thiểu 5 phút (300.000 ms)
      const COOLDOWN_MS = 5 * 60 * 1000;
      const lastSwitch = info.lastSwitchTime || 0;
      const elapsed = now - lastSwitch;

      if (elapsed < COOLDOWN_MS) {
        const waitMinutes = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
        return res.json({
          active: false,
          isKicked: true,
          message: `Tài khoản vừa chuyển thiết bị gần đây. Vui lòng đợi ${waitMinutes} phút nữa để đăng nhập lại!`
        });
      }

      // Đủ điều kiện -> Cập nhật thiết bị mới làm thiết bị chính, thiết bị cũ bị đá ra
      info.deviceToken = token;
      info.lastSwitchTime = now;
      info.switchCountToday = (info.switchCountToday || 0) + 1;
      info.lastSwitchDate = todayStr;
      licenses[hwid] = info;
      saveLicenses(licenses);
    } else if (!info.deviceToken) {
      info.deviceToken = token;
      info.lastSwitchTime = now;
      info.switchCountToday = 0;
      info.lastSwitchDate = todayStr;
      if (!info.adminPin) info.adminPin = "1234";
      licenses[hwid] = info;
      saveLicenses(licenses);
    }
  } else if (token) {
    if (info.deviceToken !== token) {
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
    adminPin: info.adminPin || "1234",
    deviceToken: info.deviceToken || null
  });
});

// Endpoint đồng bộ khi khách đổi mã PIN trong phần Cài đặt
app.get('/api/sync-pin', (req, res) => {
  let hwid = (req.query.hwid || '').trim().toUpperCase();
  const newPin = (req.query.newPin || '').trim();
  const token = (req.query.token || '').trim();

  if (!hwid || !newPin || newPin.length !== 4) {
    return res.json({ success: false, message: 'Dữ liệu không hợp lệ' });
  }

  const licenses = loadLicenses();
  let info = licenses[hwid];
  if (!info) {
    const altHwid = hwid.replace(/-/g, '');
    info = licenses[altHwid];
    if (info) hwid = altHwid;
  }

  if (info && info.deviceToken === token) {
    info.adminPin = newPin;
    licenses[hwid] = info;
    saveLicenses(licenses);
    return res.json({ success: true, message: 'Đã cập nhật mã PIN trên máy chủ!' });
  }

  return res.json({ success: false, message: 'Không thể đồng bộ mã PIN' });
});

// Webhook tiếp nhận thanh toán tự động từ SePay
app.post('/api/sepay-webhook', (req, res) => {
  const body = req.body;
  const content = (body.content || body.description || '').toUpperCase();
  const amount = parseInt(body.transferAmount || body.amount || 0);

  console.log(`[SePay Webhook] Tiền: ${amount} đ | Nội dung: ${content}`);

  if (!content.includes('HOTEL')) {
    return res.json({ success: false, message: 'Giao dịch không thuộc HOTEL POS' });
  }

  const normalized = content.replace(/[^A-Z0-9]/g, '');
  let hwid = null;

  const matchAndr = normalized.match(/HOTELANDR([A-Z0-9]{8})/);
  if (matchAndr) {
    hwid = `HOTEL-ANDR-${matchAndr[1]}`;
  } else {
    const matchPhone = normalized.match(/HOTEL(0[35789][0-9]{8})/);
    if (matchPhone) {
      hwid = `HOTEL-${matchPhone[1]}`;
    } else {
      const matchDesktop = normalized.match(/HOTEL([A-Z0-9]{4})([A-Z0-9]{4})/);
      if (matchDesktop) {
        hwid = `HOTEL-${matchDesktop[1]}-${matchDesktop[2]}`;
      } else {
        const matchMobile = normalized.match(/HOTEL([A-Z0-9]+)/);
        if (matchMobile) {
          hwid = `HOTEL-${matchMobile[1]}`;
        }
      }
    }
  }

  if (!hwid) {
    return res.status(400).json({ error: 'Nội dung chuyển khoản không đúng định dạng HOTEL' });
  }

  const now = Date.now();
  let addTimeMs = 0;
  let pkgName = '';

  if (amount >= 299000) {
    addTimeMs = 180 * 24 * 60 * 60 * 1000;
    pkgName = '6_THANG';
  } else if (amount >= 59000) {
    addTimeMs = 30 * 24 * 60 * 60 * 1000;
    pkgName = '1_THANG';
  } else if (amount >= 2000) {
    addTimeMs = 10 * 60 * 1000;
    pkgName = '10_PHUT';
  } else {
    return res.json({ success: false, message: 'Số tiền không khớp gói bản quyền nào' });
  }

  const licenses = loadLicenses();
  const currentExpire = (licenses[hwid] && licenses[hwid].expireAt > now) ? licenses[hwid].expireAt : now;

  licenses[hwid] = {
    hwid: hwid,
    expireAt: currentExpire + addTimeMs,
    package: pkgName,
    lastPaymentAmount: amount,
    deviceToken: licenses[hwid] ? licenses[hwid].deviceToken : null,
    adminPin: licenses[hwid] && licenses[hwid].adminPin ? licenses[hwid].adminPin : "1234",
    lastSwitchTime: licenses[hwid] ? licenses[hwid].lastSwitchTime : 0,
    switchCountToday: licenses[hwid] ? licenses[hwid].switchCountToday : 0,
    lastSwitchDate: licenses[hwid] ? licenses[hwid].lastSwitchDate : '',
    updatedAt: new Date().toISOString()
  };

  saveLicenses(licenses);
  console.log(`[HOTEL POS] ĐÃ KÍCH HOẠT THÀNH CÔNG CHO: ${hwid}`);

  return res.json({ success: true, hwid, expireAt: licenses[hwid].expireAt });
});

// Endpoint kích hoạt khẩn cấp trực tiếp
app.get('/api/admin-activate', (req, res) => {
  let hwid = (req.query.hwid || '').trim().toUpperCase();
  const days = parseInt(req.query.days || 30);
  if (!hwid) return res.send('Thiếu hwid');

  const licenses = loadLicenses();
  const now = Date.now();

  licenses[hwid] = {
    hwid: hwid,
    expireAt: now + days * 24 * 60 * 60 * 1000,
    package: `${days}_NGAY_ADMIN`,
    deviceToken: null,
    adminPin: "1234",
    lastSwitchTime: 0,
    switchCountToday: 0,
    lastSwitchDate: '',
    updatedAt: new Date().toISOString()
  };

  saveLicenses(licenses);
  return res.json({ success: true, message: `Đã kích hoạt ${days} ngày cho ${hwid}`, expireAt: licenses[hwid].expireAt });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HOTEL License Server đang chạy tại cổng ${PORT}`);
});
