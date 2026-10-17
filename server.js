const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_SECRET_KEY = 'ADMIN_LUHU_2026';

// Chuỗi kết nối MongoDB Atlas của bạn
const MONGO_URI = "mongodb+srv://vominhluanytb_db_user:yhVSvXpDXvPFsa46@luan.ygb6k80.mongodb.net/hotel_pos?retryWrites=true&w=majority&appName=Luan";
const client = new MongoClient(MONGO_URI);

let licensesCollection;
let staffCollection;
let settingsCollection;

// Kết nối MongoDB Database
async function connectDB() {
  try {
    await client.connect();
    const db = client.db('hotel_pos');
    licensesCollection = db.collection('licenses');
    staffCollection = db.collection('staff');
    settingsCollection = db.collection('system_settings');
    console.log("✅ Đã kết nối thành công tới Cloud MongoDB Atlas!");
  } catch (err) {
    console.error("❌ Lỗi kết nối MongoDB:", err);
  }
}
connectDB();

// Endpoint ping chống ngủ đông cho Render
app.get('/ping', (req, res) => {
  res.send({ status: 'active', serverTime: new Date().toISOString() });
});

// ================= API THÔNG BÁO HỆ THỐNG TOÀN DIỆN =================

// 1. Phía máy khách đọc thông báo định kỳ
app.get('/api/announcement', async (req, res) => {
  try {
    if (!settingsCollection) {
      return res.json({ active: false, message: '' });
    }
    const setting = await settingsCollection.findOne({ key: 'global_announcement' });
    if (setting && setting.active && setting.message) {
      return res.json({ active: true, message: setting.message });
    }
    return res.json({ active: false, message: '' });
  } catch (e) {
    res.json({ active: false, message: '' });
  }
});

// 2. Admin cập nhật hoặc bật/tắt thông báo
app.post('/api/admin/announcement', async (req, res) => {
  const { secret, message, active } = req.body;
  if (secret !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: 'Sai mã bí mật' });
  }

  try {
    if (!settingsCollection) {
      return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });
    }

    await settingsCollection.updateOne(
      { key: 'global_announcement' },
      {
        $set: {
          message: (message || '').trim(),
          active: !!active,
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );

    res.json({ success: true, message: 'Đã cập nhật thông báo thành công!' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Lỗi cập nhật thông báo' });
  }
});

// ================= API BẢN QUYỀN & MÃ PIN =================

// Endpoint kiểm tra bản quyền & Xử lý chuyển đổi thiết bị kèm PIN
app.get('/api/check-license', async (req, res) => {
  let hwid = (req.query.hwid || '').trim().toUpperCase();
  const token = (req.query.token || '').trim();
  const pin = (req.query.pin || '').trim();

  if (!hwid) return res.status(400).json({ active: false, message: 'Thiếu HWID' });
  if (!licensesCollection) return res.status(500).json({ active: false, message: 'Database chưa sẵn sàng' });

  let info = await licensesCollection.findOne({ hwid: hwid });
  if (!info) {
    const altHwid = hwid.replace(/-/g, '');
    info = await licensesCollection.findOne({ hwid: altHwid });
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

  const todayStr = new Date().toISOString().slice(0, 10);

  // Xử lý chuyển thiết bị / trình duyệt
  if (token && hwid.startsWith('HOTEL-0')) {
    if (info.deviceToken && info.deviceToken !== token) {
      const correctPin = info.adminPin || "1234";
      if (!pin || pin !== correctPin) {
        return res.json({
          active: false,
          isKicked: true,
          requirePin: true,
          message: 'Mã PIN quản trị không đúng! Vui lòng nhập đúng PIN 4 số để chuyển thiết bị.'
        });
      }

      if (info.lastSwitchDate !== todayStr) {
        info.switchCountToday = 0;
        info.lastSwitchDate = todayStr;
      }

      const MAX_SWITCH_PER_DAY = 5;
      if ((info.switchCountToday || 0) >= MAX_SWITCH_PER_DAY) {
        return res.json({
          active: false,
          isKicked: true,
          message: 'Bạn đã đổi thiết bị quá 5 lần hôm nay. Vui lòng quay lại vào ngày mai!'
        });
      }

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

      await licensesCollection.updateOne(
        { hwid: hwid },
        {
          $set: {
            deviceToken: token,
            lastSwitchTime: now,
            switchCountToday: (info.switchCountToday || 0) + 1,
            lastSwitchDate: todayStr
          }
        }
      );
    } else if (!info.deviceToken) {
      await licensesCollection.updateOne(
        { hwid: hwid },
        {
          $set: {
            deviceToken: token,
            lastSwitchTime: now,
            switchCountToday: 0,
            lastSwitchDate: todayStr,
            adminPin: info.adminPin || "1234"
          }
        }
      );
    }
  } else if (token && info.deviceToken !== token) {
    await licensesCollection.updateOne({ hwid: hwid }, { $set: { deviceToken: token } });
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

// Đồng bộ khi khách đổi PIN trong Cài đặt
app.get('/api/sync-pin', async (req, res) => {
  let hwid = (req.query.hwid || '').trim().toUpperCase();
  const newPin = (req.query.newPin || '').trim();
  const token = (req.query.token || '').trim();

  if (!hwid || !newPin || newPin.length !== 4) {
    return res.json({ success: false, message: 'Dữ liệu không hợp lệ' });
  }
  if (!licensesCollection) {
    return res.json({ success: false, message: 'Database chưa sẵn sàng' });
  }

  let info = await licensesCollection.findOne({ hwid: hwid });
  if (!info) {
    const altHwid = hwid.replace(/-/g, '');
    info = await licensesCollection.findOne({ hwid: altHwid });
    if (info) hwid = altHwid;
  }

  if (info && info.deviceToken === token) {
    await licensesCollection.updateOne({ hwid: hwid }, { $set: { adminPin: newPin } });
    return res.json({ success: true, message: 'Đã cập nhật mã PIN trên máy chủ!' });
  }

  return res.json({ success: false, message: 'Không thể đồng bộ mã PIN' });
});

// Webhook SePay lưu trực tiếp vào MongoDB
app.post('/api/sepay-webhook', async (req, res) => {
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

  // BẢNG GIÁ MỚI: 2.000đ/15 phút, 99.000đ/1 tháng, 499.000đ/6 tháng
  if (amount >= 499000) {
    addTimeMs = 180 * 24 * 60 * 60 * 1000;
    pkgName = '6_THANG';
  } else if (amount >= 99000) {
    addTimeMs = 30 * 24 * 60 * 60 * 1000;
    pkgName = '1_THANG';
  } else if (amount >= 2000) {
    addTimeMs = 15 * 60 * 1000;
    pkgName = '15_PHUT';
  } else {
    return res.json({ success: false, message: 'Số tiền không khớp gói bản quyền nào' });
  }

  const existing = (await licensesCollection.findOne({ hwid: hwid })) || {};
  const currentExpire = (existing.expireAt && existing.expireAt > now) ? existing.expireAt : now;
  const newExpire = currentExpire + addTimeMs;

  const history = existing.paymentHistory || [];
  history.push({
    amount: amount,
    package: pkgName,
    time: new Date().toISOString(),
    transactionId: body.id || Date.now()
  });

  await licensesCollection.updateOne(
    { hwid: hwid },
    {
      $set: {
        hwid: hwid,
        expireAt: newExpire,
        package: pkgName,
        lastPaymentAmount: amount,
        lastPaymentTime: new Date().toISOString(),
        deviceToken: existing.deviceToken || null,
        adminPin: existing.adminPin || "1234",
        lastSwitchTime: existing.lastSwitchTime || 0,
        switchCountToday: existing.switchCountToday || 0,
        lastSwitchDate: existing.lastSwitchDate || '',
        updatedAt: new Date().toISOString(),
        paymentHistory: history
      }
    },
    { upsert: true }
  );

  console.log(`[HOTEL POS] ĐÃ KÍCH HOẠT THÀNH CÔNG CHO: ${hwid} - Hạn mới: ${new Date(newExpire).toLocaleString('vi-VN')}`);
  return res.json({ success: true, hwid, expireAt: newExpire });
});

// Endpoint kích hoạt khẩn cấp trực tiếp
app.get('/api/admin-activate', async (req, res) => {
  let hwid = (req.query.hwid || '').replace(/[<>]/g, '').trim().toUpperCase();
  const days = parseInt(req.query.days || 30);
  if (!hwid) return res.send('Thiếu hwid');

  const now = Date.now();
  const existing = (await licensesCollection.findOne({ hwid: hwid })) || {};

  const expireAt = now + days * 24 * 60 * 60 * 1000;
  await licensesCollection.updateOne(
    { hwid: hwid },
    {
      $set: {
        hwid: hwid,
        expireAt: expireAt,
        package: `${days}_NGAY_ADMIN`,
        lastPaymentAmount: 0,
        lastPaymentTime: new Date().toISOString(),
        deviceToken: null,
        adminPin: existing.adminPin || "1234",
        lastSwitchTime: 0,
        switchCountToday: 0,
        lastSwitchDate: '',
        updatedAt: new Date().toISOString(),
        paymentHistory: existing.paymentHistory || []
      }
    },
    { upsert: true }
  );

  return res.json({ success: true, message: `Đã kích hoạt ${days} ngày cho ${hwid}`, expireAt });
});

// Reset mã PIN về 1234 giữ nguyên ngày dùng
app.get('/api/admin-reset-pin', async (req, res) => {
  let hwid = (req.query.hwid || '').replace(/[<>]/g, '').trim().toUpperCase();
  const pin = (req.query.pin || '1234').trim();

  if (!hwid) return res.status(400).send('Thiếu tham số hwid');

  let info = await licensesCollection.findOne({ hwid: hwid });
  if (!info) {
    const altHwid = hwid.replace(/-/g, '');
    info = await licensesCollection.findOne({ hwid: altHwid });
    if (info) hwid = altHwid;
  }

  if (!info) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy cơ sở này trên server!' });
  }

  await licensesCollection.updateOne({ hwid: hwid }, { $set: { adminPin: pin, updatedAt: new Date().toISOString() } });

  return res.json({
    success: true,
    message: `Đã reset mã PIN của ${hwid} về: ${pin} (Thời hạn giữ nguyên)`,
    expireAt: info.expireAt,
    expireDate: new Date(info.expireAt).toLocaleString('vi-VN')
  });
});

// Endpoint ngưng / khóa tài khoản khẩn cấp (khi khách mất máy hoặc báo khóa)
app.get('/api/admin-suspend', async (req, res) => {
  let hwid = (req.query.hwid || '').trim().toUpperCase();
  const secret = req.query.secret;

  if (secret !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: 'Sai khóa bảo mật' });
  }
  if (!hwid) return res.status(400).json({ success: false, message: 'Thiếu HWID' });

  let info = await licensesCollection.findOne({ hwid: hwid });
  if (!info) {
    const altHwid = hwid.replace(/-/g, '');
    info = await licensesCollection.findOne({ hwid: altHwid });
    if (info) hwid = altHwid;
  }

  if (!info) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy cơ sở này!' });
  }

  // Khóa bằng cách đưa hạn sử dụng về 0 và xóa deviceToken
  await licensesCollection.updateOne(
    { hwid: hwid },
    {
      $set: {
        expireAt: 0,
        deviceToken: null,
        updatedAt: new Date().toISOString()
      }
    }
  );

  return res.json({
    success: true,
    message: `Đã khóa/ngưng hoạt động tài khoản ${hwid} thành công! Khách sẽ bị đẩy ra ngoài ngay lập tức.`
  });
});

// API Dashboard Admin lấy danh sách từ Cloud MongoDB
app.get('/api/admin/dashboard-data', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: 'Từ chối truy cập! Khóa bí mật không đúng.' });
  }

  try {
    const allLicenses = await licensesCollection.find({}).toArray();
    const customerList = [];
    const now = Date.now();

    for (let item of allLicenses) {
      const hwid = item.hwid || '';
      const isCleanHwid = hwid.startsWith('HOTEL-') ? hwid : 'HOTEL-' + hwid;
      const phone = hwid.replace('HOTEL-', '').replace(/[^0-9]/g, '');

      customerList.push({
        hwid: isCleanHwid,
        phone: phone || hwid,
        adminPin: item.adminPin || '1234',
        expireAt: item.expireAt || 0,
        expireDate: item.expireAt ? new Date(item.expireAt).toLocaleString('vi-VN') : 'Chưa có',
        isActive: (item.expireAt || 0) > now,
        daysLeft: Math.max(0, Math.ceil(((item.expireAt || 0) - now) / (1000 * 60 * 60 * 24))),
        lastPaymentAmount: item.lastPaymentAmount || 0,
        lastPaymentTime: item.lastPaymentTime ? new Date(item.lastPaymentTime).toLocaleString('vi-VN') : '---',
        lastSwitchAt: item.lastSwitchTime ? new Date(item.lastSwitchTime).toLocaleString('vi-VN') : '---',
        paymentHistory: item.paymentHistory || []
      });
    }

    customerList.sort((a, b) => b.expireAt - a.expireAt);

    res.json({
      success: true,
      totalCustomers: customerList.length,
      activeCustomers: customerList.filter(c => c.isActive).length,
      customers: customerList
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi truy vấn MongoDB' });
  }
});

// ================= API QUẢN LÝ NHÂN VIÊN & KHEN THƯỞNG =================

// 1. Lấy danh sách nhân viên và danh sách khách của họ
app.get('/api/admin/staff-list', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ success: false });
  try {
    if (!staffCollection) return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });
    const list = await staffCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, staff: list });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách nhân viên' });
  }
});

// 2. Thêm nhân viên mới
app.post('/api/admin/staff-add', async (req, res) => {
  const { secret, name } = req.body;
  if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ success: false });
  if (!name || !name.trim()) return res.json({ success: false, message: 'Vui lòng nhập tên nhân viên' });

  try {
    if (!staffCollection) return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });
    const cleanName = name.trim();
    const exist = await staffCollection.findOne({ name: cleanName });
    if (exist) return res.json({ success: false, message: 'Tên nhân viên này đã tồn tại!' });

    await staffCollection.insertOne({
      name: cleanName,
      customers: [],
      createdAt: new Date().toISOString()
    });
    res.json({ success: true, message: 'Đã thêm nhân viên thành công!' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Lỗi thêm nhân viên' });
  }
});

// 3. Gán số điện thoại khách hàng cho nhân viên (chống trùng lặp)
app.post('/api/admin/staff-assign-customer', async (req, res) => {
  const { secret, staffName, phone } = req.body;
  if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ success: false });

  const cleanPhone = (phone || '').replace(/[^0-9]/g, '').trim();
  if (!cleanPhone || cleanPhone.length < 9) {
    return res.json({ success: false, message: 'Số điện thoại không hợp lệ!' });
  }

  try {
    if (!staffCollection) return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });

    // Kiểm tra xem số này đã được tính cho nhân viên nào chưa
    const alreadyAssigned = await staffCollection.findOne({ "customers.phone": cleanPhone });
    if (alreadyAssigned) {
      return res.json({
        success: false,
        message: `Số ${cleanPhone} đã được tính cho nhân viên: "${alreadyAssigned.name}" rồi!`
      });
    }

    // Thêm khách vào danh sách của nhân viên
    await staffCollection.updateOne(
      { name: staffName },
      {
        $push: {
          customers: {
            phone: cleanPhone,
            assignedAt: new Date().toISOString()
          }
        }
      }
    );
    res.json({ success: true, message: `Đã lưu khách ${cleanPhone} cho nhân viên ${staffName}!` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Lỗi gán khách hàng' });
  }
});

// 4. Xóa khách khỏi nhân viên nếu nhập nhầm
app.post('/api/admin/staff-remove-customer', async (req, res) => {
  const { secret, staffName, phone } = req.body;
  if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ success: false });

  try {
    if (!staffCollection) return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });
    await staffCollection.updateOne(
      { name: staffName },
      { $pull: { customers: { phone: phone } } }
    );
    res.json({ success: true, message: 'Đã xóa khách khỏi danh sách nhân viên!' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Lỗi xóa khách' });
  }
});

// 5. Xóa hoàn toàn nhân viên khi nghỉ việc hoặc nhập sai tên
app.post('/api/admin/staff-delete', async (req, res) => {
  const { secret, name } = req.body;
  if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ success: false });

  try {
    if (!staffCollection) return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });
    await staffCollection.deleteOne({ name: name });
    res.json({ success: true, message: `Đã xóa nhân viên ${name} khỏi hệ thống!` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Lỗi xóa nhân viên' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HOTEL License Server đang chạy tại cổng ${PORT}`);
});
