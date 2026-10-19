const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ADMIN_SECRET_KEY = 'ADMIN_LUHU_2026';

// Chuỗi kết nối MongoDB Atlas
const MONGO_URI = "mongodb+srv://vominhluanytb_db_user:yhVSvXpDXvPFsa46@luan.ygb6k80.mongodb.net/hotel_pos?retryWrites=true&w=majority&appName=Luan";
const client = new MongoClient(MONGO_URI);

let licensesCollection;
let staffCollection;
let settingsCollection;
let hotelDataCollection;

async function connectDB() {
  try {
    await client.connect();
    const db = client.db('hotel_pos');
    licensesCollection = db.collection('licenses');
    staffCollection = db.collection('staff');
    settingsCollection = db.collection('system_settings');
    hotelDataCollection = db.collection('hotel_cloud_data');
    console.log("✅ Đã kết nối thành công tới Cloud MongoDB Atlas!");
  } catch (err) {
    console.error("❌ Lỗi kết nối MongoDB:", err);
  }
}
connectDB();

app.get('/ping', (req, res) => {
  res.send({ status: 'active', serverTime: new Date().toISOString() });
});

// ================= API ĐỒNG BỘ DỮ LIỆU ĐÁM MÂY (GIỮ 6 THÁNG GẦN NHẤT) =================
app.post('/api/sync-data', async (req, res) => {
  try {
    if (!hotelDataCollection) {
      return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });
    }

    let { hwid, data } = req.body;
    if (!hwid || !data) return res.status(400).json({ success: false, message: 'Thiếu thông tin' });

    hwid = hwid.trim().toUpperCase();

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setDate(sixMonthsAgo.getDate() - 180);

    if (data.history && Array.isArray(data.history)) {
      data.history = data.history.filter(item => {
        const itemDate = new Date(item.checkOut || item.id);
        return itemDate >= sixMonthsAgo;
      });
    }

    if (data.inventory && Array.isArray(data.inventory)) {
      data.inventory = data.inventory.filter(item => {
        const itemDate = new Date(item.createdAt || item.id);
        return itemDate >= sixMonthsAgo;
      });
    }

    await hotelDataCollection.updateOne(
      { hwid: hwid },
      {
        $set: {
          hwid: hwid,
          data: data,
          updatedAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );

    res.json({ success: true, message: 'Đã lưu đám mây thành công (giữ 6 tháng gần nhất)' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/get-data', async (req, res) => {
  try {
    if (!hotelDataCollection) {
      return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });
    }

    let hwid = (req.query.hwid || '').trim().toUpperCase();
    if (!hwid) return res.status(400).json({ success: false, message: 'Thiếu HWID' });

    let record = await hotelDataCollection.findOne({ hwid: hwid });
    if (!record) {
      const altHwid = hwid.replace(/-/g, '');
      record = await hotelDataCollection.findOne({ hwid: altHwid });
    }

    if (!record || !record.data) {
      return res.json({ success: false, message: 'Chưa có bản lưu nào trên đám mây' });
    }

    res.json({ success: true, data: record.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================= API THÔNG BÁO HỆ THỐNG TOÀN DIỆN =================
app.get('/api/announcement', async (req, res) => {
  try {
    if (!settingsCollection) return res.json({ active: false, message: '' });
    const setting = await settingsCollection.findOne({ key: 'global_announcement' });
    if (setting && setting.active && setting.message) {
      return res.json({ active: true, message: setting.message });
    }
    return res.json({ active: false, message: '' });
  } catch (e) {
    res.json({ active: false, message: '' });
  }
});

app.post('/api/admin/announcement', async (req, res) => {
  const { secret, message, active } = req.body;
  if (secret !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: 'Sai mã bí mật' });
  }

  try {
    if (!settingsCollection) return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });

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

// ================= API BẢN QUYỀN & MÃ PIN (QUẢN LÝ THIẾT BỊ ĐÃ KHẮC PHỤC TRIỆT ĐỂ) =================
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
  const allowedLimit = info.maxDevices || 1; // 1 máy hoặc 3 máy

  if (token && hwid.startsWith('HOTEL-0')) {
    let tokens = info.deviceTokens || (info.deviceToken ? [info.deviceToken] : []);

    // 1. Máy này đã nằm sẵn trong danh sách hợp lệ
    if (tokens.includes(token)) {
      // Cho qua bình thường
    } 
    // 2. Máy mới và chưa đầy số lượng máy cho phép
    else if (tokens.length < allowedLimit) {
      tokens.push(token);
      await licensesCollection.updateOne(
        { hwid: hwid },
        { 
          $set: { 
            deviceTokens: tokens,
            deviceToken: token,
            lastSwitchDate: todayStr,
            adminPin: info.adminPin || "1234"
          } 
        }
      );
    } 
    // 3. Đã đủ máy nhưng máy này CÓ NHẬP ĐÚNG PIN QUẢN TRỊ (Đổi máy có chủ đích)
    else if (pin && pin === (info.adminPin || "1234")) {
      // Đẩy máy cũ nhất ra, nạp máy mới này vào
      while (tokens.length >= allowedLimit) {
        tokens.shift();
      }
      tokens.push(token);

      await licensesCollection.updateOne(
        { hwid: hwid },
        {
          $set: {
            deviceTokens: tokens,
            deviceToken: token,
            lastSwitchTime: now,
            lastSwitchDate: todayStr
          }
        }
      );
    } 
    // 4. Máy này không có trong danh sách (đã bị máy khác ngắt) HOẶC mở mới mà không nhập đúng PIN
    else {
      return res.json({
        active: false,
        isKicked: true, // Cờ này kích hoạt lệnh xóa sạch dữ liệu trên máy cũ
        requirePin: true,
        message: `Tài khoản đã đổi sang thiết bị khác! Thiết bị này đã bị ngắt kết nối.`
      });
    }
  }

  return res.json({
    active: true,
    expireAt: info.expireAt,
    expireDate: new Date(info.expireAt).toLocaleString('vi-VN'),
    package: info.package,
    maxDevices: allowedLimit,
    adminPin: info.adminPin || "1234",
    deviceTokens: info.deviceTokens || []
  });
});

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

  const tokens = info ? (info.deviceTokens || [info.deviceToken]) : [];
  if (info && tokens.includes(token)) {
    await licensesCollection.updateOne({ hwid: hwid }, { $set: { adminPin: newPin } });
    return res.json({ success: true, message: 'Đã cập nhật mã PIN trên máy chủ!' });
  }

  return res.json({ success: false, message: 'Không thể đồng bộ mã PIN' });
});

// Webhook SePay: Nhận diện 3 gói cước chuẩn
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
  let maxDevices = 1;

  if (amount >= 499000) {
    addTimeMs = 180 * 24 * 60 * 60 * 1000;
    pkgName = '1_MAY_6_THANG';
    maxDevices = 1;
  } else if (amount >= 149000) {
    addTimeMs = 30 * 24 * 60 * 60 * 1000;
    pkgName = '3_MAY_1_THANG';
    maxDevices = 3;
  } else if (amount >= 99000) {
    addTimeMs = 30 * 24 * 60 * 60 * 1000;
    pkgName = '1_MAY_1_THANG';
    maxDevices = 1;
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
    maxDevices: maxDevices,
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
        maxDevices: maxDevices,
        lastPaymentAmount: amount,
        lastPaymentTime: new Date().toISOString(),
        adminPin: existing.adminPin || "1234",
        updatedAt: new Date().toISOString(),
        paymentHistory: history
      }
    },
    { upsert: true }
  );

  console.log(`[HOTEL POS] KÍCH HOẠT THÀNH CÔNG: ${hwid} (${pkgName} - ${maxDevices} máy) - Hạn mới: ${new Date(newExpire).toLocaleString('vi-VN')}`);
  return res.json({ success: true, hwid, expireAt: newExpire });
});

// API Admin Cấp Dùng Thử / Kích Hoạt Nhanh (POST) - Tự động xóa sạch danh sách thiết bị kẹt cũ
app.post('/api/admin/grant-trial', async (req, res) => {
  const { secret, phone, days, maxDevices } = req.body;
  if (secret !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: 'Sai mã bí mật quản trị!' });
  }

  const cleanPhone = (phone || '').replace(/[^0-9]/g, '').trim();
  const trialDays = parseInt(days) || 3;
  const devicesLimit = parseInt(maxDevices) || 1;

  if (!cleanPhone || cleanPhone.length < 9) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đúng số điện thoại!' });
  }

  try {
    if (!licensesCollection) {
      return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng!' });
    }

    const hwid = `HOTEL-${cleanPhone}`;
    const now = Date.now();
    const existing = (await licensesCollection.findOne({ hwid: hwid })) || {};

    const baseTime = (existing.expireAt && existing.expireAt > now) ? existing.expireAt : now;
    const expireAt = baseTime + trialDays * 24 * 60 * 60 * 1000;

    await licensesCollection.updateOne(
      { hwid: hwid },
      {
        $set: {
          hwid: hwid,
          expireAt: expireAt,
          package: `DUNG_THU_${trialDays}_NGAY`,
          maxDevices: devicesLimit,
          deviceTokens: [], // Xóa sạch danh sách máy kẹt để nạp thiết bị mới mượt mà
          deviceToken: null,
          lastPaymentAmount: 0,
          lastPaymentTime: new Date().toISOString(),
          adminPin: existing.adminPin || "1234",
          updatedAt: new Date().toISOString(),
          paymentHistory: existing.paymentHistory || []
        }
      },
      { upsert: true }
    );

    res.json({
      success: true,
      message: `Đã cấp ${trialDays} ngày (${devicesLimit} máy) cho SĐT ${cleanPhone}!`,
      expireDate: new Date(expireAt).toLocaleString('vi-VN')
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi server: ' + err.message });
  }
});

// Endpoint kích hoạt khẩn cấp qua GET
app.get('/api/admin-activate', async (req, res) => {
  let param = (req.query.hwid || req.query.phone || '').trim().toUpperCase();
  const days = parseInt(req.query.days || 30);
  const maxDevices = parseInt(req.query.maxDevices || 1);
  if (!param) return res.send('Thiếu hwid hoặc số điện thoại');

  let hwid = param.startsWith('HOTEL-') ? param : `HOTEL-${param.replace(/[^0-9]/g, '')}`;

  const now = Date.now();
  const existing = (await licensesCollection.findOne({ hwid: hwid })) || {};

  const baseTime = (existing.expireAt && existing.expireAt > now) ? existing.expireAt : now;
  const expireAt = baseTime + days * 24 * 60 * 60 * 1000;

  await licensesCollection.updateOne(
    { hwid: hwid },
    {
      $set: {
        hwid: hwid,
        expireAt: expireAt,
        package: `${days}_NGAY_ADMIN`,
        maxDevices: maxDevices,
        deviceTokens: [],
        deviceToken: null,
        lastPaymentAmount: 0,
        lastPaymentTime: new Date().toISOString(),
        adminPin: existing.adminPin || "1234",
        updatedAt: new Date().toISOString(),
        paymentHistory: existing.paymentHistory || []
      }
    },
    { upsert: true }
  );

  return res.json({ success: true, message: `Đã kích hoạt ${days} ngày (${maxDevices} máy) cho ${hwid}`, expireAt });
});

// Reset PIN về 1234 đồng thời giải phóng danh sách thiết bị
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

  await licensesCollection.updateOne(
    { hwid: hwid }, 
    { 
      $set: { 
        adminPin: pin, 
        deviceTokens: [], // Xóa sạch danh sách máy kẹt cũ
        deviceToken: null,
        updatedAt: new Date().toISOString() 
      } 
    }
  );

  return res.json({
    success: true,
    message: `Đã reset mã PIN của ${hwid} về: ${pin} và xóa sạch danh sách thiết bị cũ!`,
    expireAt: info.expireAt,
    expireDate: new Date(info.expireAt).toLocaleString('vi-VN')
  });
});

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

  await licensesCollection.updateOne(
    { hwid: hwid },
    {
      $set: {
        expireAt: 0,
        deviceTokens: [],
        deviceToken: null,
        updatedAt: new Date().toISOString()
      }
    }
  );

  return res.json({
    success: true,
    message: `Đã khóa/ngưng hoạt động tài khoản ${hwid} thành công!`
  });
});

app.get('/api/admin/dashboard-data', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: 'Từ chối truy cập!' });
  }

  try {
    const allLicenses = await licensesCollection.find({}).toArray();
    const customerList = [];
    const now = Date.now();

    for (let item of allLicenses) {
      const hwid = item.hwid || '';
      const isCleanHwid = hwid.startsWith('HOTEL-') ? hwid : 'HOTEL-' + hwid;
      const phone = hwid.replace('HOTEL-', '').replace(/[^0-9]/g, '');
      const activeDevices = (item.deviceTokens && Array.isArray(item.deviceTokens)) ? item.deviceTokens.length : (item.deviceToken ? 1 : 0);

      customerList.push({
        hwid: isCleanHwid,
        phone: phone || hwid,
        adminPin: item.adminPin || '1234',
        expireAt: item.expireAt || 0,
        expireDate: item.expireAt ? new Date(item.expireAt).toLocaleString('vi-VN') : 'Chưa có',
        isActive: (item.expireAt || 0) > now,
        maxDevices: item.maxDevices || 1,
        activeDevices: activeDevices,
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

app.post('/api/admin/staff-assign-customer', async (req, res) => {
  const { secret, staffName, phone } = req.body;
  if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ success: false });

  const cleanPhone = (phone || '').replace(/[^0-9]/g, '').trim();
  if (!cleanPhone || cleanPhone.length < 9) {
    return res.json({ success: false, message: 'Số điện thoại không hợp lệ!' });
  }

  try {
    if (!staffCollection) return res.status(500).json({ success: false, message: 'Database chưa sẵn sàng' });

    const alreadyAssigned = await staffCollection.findOne({ "customers.phone": cleanPhone });
    if (alreadyAssigned) {
      return res.json({
        success: false,
        message: `Số ${cleanPhone} đã được tính cho nhân viên: "${alreadyAssigned.name}" rồi!`
      });
    }

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
