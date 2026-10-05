// Запуск: BOT_TOKEN=... CHAT_ID=... ADMIN_IDS=123,456 CLOUDINARY_URL=cloudinary://KEY:SECRET@CLOUD node server.js   (Node 18+, без залежностей)
// Сайт, API каталогу і Telegram-бот працюють в одному процесі.
// Каталог (cars.json) і фото зберігаються в Cloudinary, тому не пропадають при рестарті/редеплої Render.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { BOT_TOKEN, CHAT_ID, ADMIN_IDS = '', PORT = 3000 } = process.env;
const ROOT = __dirname, DB = path.join(ROOT, 'cars.json'), IMG = path.join(ROOT, 'img');
const ADMINS = new Set(ADMIN_IDS.split(',').map(s => s.trim()).filter(Boolean));
const CUR = 'zł';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

process.on('uncaughtException', e => console.error('uncaught:', e));
process.on('unhandledRejection', e => console.error('unhandled:', e));

// ===== Cloudinary (без SDK) =====
// CLOUDINARY_URL береться з Dashboard → API Keys: cloudinary://API_KEY:API_SECRET@CLOUD_NAME
const CLD = (() => {
  const m = (process.env.CLOUDINARY_URL || '').match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  return m ? { key: m[1], secret: m[2], cloud: m[3] } : null;
})();
const CLD_DIR = 'autokomis', CLD_DB = CLD_DIR + '/cars.json';

const cldSign = p => crypto.createHash('sha1')
  .update(Object.keys(p).sort().map(k => `${k}=${p[k]}`).join('&') + CLD.secret).digest('hex');

async function cldUpload(buf, publicId, type = 'image') {
  const p = { invalidate: 'true', overwrite: 'true', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) };
  const f = new FormData();
  f.append('file', new Blob([buf]), publicId.split('/').pop());
  for (const k in p) f.append(k, p[k]);
  f.append('api_key', CLD.key);
  f.append('signature', cldSign(p));
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/${type}/upload`, { method: 'POST', body: f }).then(r => r.json());
  if (!r.secure_url) throw new Error('cloudinary upload: ' + JSON.stringify(r));
  return r.secure_url;
}

async function cldDestroy(publicId) {
  const p = { invalidate: 'true', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) };
  const body = new URLSearchParams({ ...p, api_key: CLD.key, signature: cldSign(p) });
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/image/destroy`, { method: 'POST', body }).then(r => r.json());
  if (!['ok', 'not found'].includes(r.result)) throw new Error('cloudinary destroy: ' + JSON.stringify(r));
}

// ===== Сховище каталогу =====
let cars = [];

async function loadCars() {
  const local = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
  if (!CLD) { console.warn('CLOUDINARY_URL не задано — дані зберігаються локально і зникнуть при рестарті на Render!'); cars = local(); return; }

  const auth = 'Basic ' + Buffer.from(`${CLD.key}:${CLD.secret}`).toString('base64');
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/resources/raw/upload/${CLD_DB}`, { headers: { Authorization: auth } });
  if (r.status === 404) {            // перший запуск: каталогу в хмарі ще нема
    cars = local();
    await saveRemote();
    return;
  }
  if (!r.ok) throw new Error('Не вдалося завантажити каталог з Cloudinary: ' + r.status + ' ' + await r.text());
  const info = await r.json();
  const data = await fetch(info.secure_url).then(x => { if (!x.ok) throw new Error('download ' + x.status); return x.json(); });
  if (!Array.isArray(data)) throw new Error('Каталог у Cloudinary має неправильний формат');
  cars = data;
}

const saveRemote = () => cldUpload(Buffer.from(JSON.stringify(cars, null, 1)), CLD_DB, 'raw');

let saving = Promise.resolve();   // черга: збереження йдуть строго по одному, останній стан виграє
function save() {
  try {                            // локальна копія (запасна)
    fs.writeFileSync(DB + '.tmp', JSON.stringify(cars, null, 1));
    fs.renameSync(DB + '.tmp', DB);
  } catch (e) { console.error('local save:', e.message); }
  if (CLD) saving = saving.then(saveRemote).catch(e => console.error('Cloudinary save error:', e.message));
  return saving;
}

const rmPhotos = c => (c.photos || []).forEach(p => {
  if (CLD && p.includes(`/${CLD_DIR}/${c.id}-`)) {
    const m = p.match(/\/(autokomis\/[^/.]+)\.\w+$/);
    if (m) cldDestroy(m[1]).catch(e => console.error(e.message));
  } else if (p.startsWith('img/' + c.id + '-')) {
    fs.rmSync(path.join(ROOT, p), { force: true });
  }
});

// ===== HTTP =====
function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const hits = new Map();   // антиспам заявок: не більше 5 за 10 хвилин з однієї IP
setInterval(() => hits.clear(), 3600_000).unref();
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 600_000);
  a.push(now); hits.set(ip, a);
  return a.length > 5;
}

async function handleLead(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (limited(ip)) return send(res, 429, { ok: false });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) { req.destroy(); return; }
  }
  let data;
  try { data = JSON.parse(raw); } catch { return send(res, 400, { ok: false }); }

  const name = String(data.name || '').trim().slice(0, 100);
  const phone = String(data.phone || '').trim().slice(0, 30);
  const car = String(data.car || '').trim().slice(0, 100);
  if (name.length < 2 || phone.replace(/\D/g, '').length < 10) return send(res, 400, { ok: false });

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('Не задано BOT_TOKEN або CHAT_ID');
    return send(res, 500, { ok: false });
  }
  const text = `Нова заявка з сайту Auto Komis\nІм'я: ${name}\nТелефон: ${phone}\nАвто: ${car}`;
  try {
    const r = await tg('sendMessage', { chat_id: CHAT_ID, text });
    if (!r.ok) throw new Error(JSON.stringify(r));
    send(res, 200, { ok: true });
  } catch (e) {
    console.error('Telegram error:', e.message);
    send(res, 502, { ok: false });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/cars' && req.method === 'GET') return send(res, 200, cars, 'application/json', { 'Cache-Control': 'no-store' });
  if (req.method === 'POST' && url.pathname === '/api/lead') return handleLead(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false });

  let rel;
  try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, ''); }
  catch { return send(res, 400, 'Bad request', 'text/plain'); }
  const file = path.join(ROOT, path.normalize(rel));
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!file.startsWith(ROOT + path.sep) || !type) return send(res, 404, 'Not found', 'text/plain');

  const cache = type.startsWith('text/html') ? 'no-cache' : 'public, max-age=86400';
  fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, type, { 'Cache-Control': cache }));
});

// ===== Telegram-бот =====
const tg = (method, body) => fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(r => r.json());
const say = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, ...extra });
const kb = opts => ({ reply_markup: { keyboard: [opts.map(text => ({ text }))], resize_keyboard: true, one_time_keyboard: true } });
const noKb = { reply_markup: { remove_keyboard: true } };

const STATUS = { 'В наявності': 'stock', 'В дорозі': 'transit', 'Продано': 'sold' };
const STEPS = [
  { k: 'brand',   q: 'Марка? (наприклад: BMW)' },
  { k: 'model',   q: 'Модель? (наприклад: 530d xDrive)' },
  { k: 'year',    q: 'Рік випуску?', num: [1950, new Date().getFullYear() + 1] },
  { k: 'km',      q: 'Пробіг, км? (можна «150к»)', num: [0, 2_000_000] },
  { k: 'engine',  q: 'Двигун? (наприклад: 2.0 л, для електро: 75 кВт·год)' },
  { k: 'fuel',    q: 'Паливо?', opts: ['Бензин', 'Дизель', 'Гібрид', 'Електро', 'Газ/бензин'] },
  { k: 'gearbox', q: 'Коробка?', opts: ['Автомат', 'Механіка'] },
  { k: 'awd',     q: 'Повний привід (4x4)?', opts: ['Так', 'Ні'] },
  { k: 'price',   q: `Ціна, ${CUR}?`, num: [1, 100_000_000] },
  { k: 'status',  q: 'Статус?', opts: Object.keys(STATUS) },
  { k: 'photos' }
];
const sess = new Map();   // chatId → { i, car, photos }

function parseNum(s) {
  const m = String(s).toLowerCase().replace(/[\s\u00A0]/g, '').replace(',', '.').match(/^(\d+(?:\.\d+)?)(к|k|тис)?$/);
  return m ? Math.round(m[1] * (m[2] ? 1000 : 1)) : null;
}

function ask(chat, s) {
  const st = STEPS[s.i];
  if (st.k === 'photos') return say(chat, 'Надішліть фото авто (можна кілька, перше буде головним). Коли всі — натисніть «Готово».', kb(['Готово', 'Без фото']));
  return say(chat, st.q, st.opts ? kb(st.opts) : noKb);
}

async function savePhoto(fileId, id, n) {
  const f = await tg('getFile', { file_id: fileId });
  if (!f.ok) throw new Error('getFile: ' + JSON.stringify(f));
  const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`);
  if (!r.ok) throw new Error('download ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (CLD) return cldUpload(buf, `${CLD_DIR}/${id}-${n}`);   // повертає https-посилання на фото
  fs.mkdirSync(IMG, { recursive: true });
  fs.writeFileSync(path.join(IMG, `${id}-${n}.jpg`), buf);
  return `img/${id}-${n}.jpg`;
}

async function finish(chat, s) {
  const c = { ...s.car, sub: '', photos: s.photos };
  cars.unshift(c); sess.delete(chat);
  await save();
  return say(chat, `✅ Додано: ${c.brand} ${c.model}, ${c.year}. Уже на сайті.\n\n/add — ще одне авто, /list — каталог`, noKb);
}

const HELP = 'Команди:\n/add — додати авто\n/list — останні авто (звідти ж: продано / видалити)\n/price ID 85000 — змінити ціну\n/cancel — скасувати додавання';

async function onMessage(m) {
  const chat = m.chat.id, uid = String(m.from.id), text = (m.text || '').trim();
  if (!ADMINS.has(uid)) return say(chat, `Немає доступу. Ваш ID: ${uid}\nДодайте його в ADMIN_IDS і перезапустіть сервер.`);

  let mm;
  if (text === '/start' || text === '/help') return say(chat, HELP, noKb);
  if (text === '/add') { const s = { i: 0, car: { id: 'c' + Date.now().toString(36) }, photos: [] }; sess.set(chat, s); return ask(chat, s); }
  if (text === '/cancel') { const s = sess.get(chat); if (s) rmPhotos({ id: s.car.id, photos: s.photos }); sess.delete(chat); return say(chat, 'Скасовано.', noKb); }
  if (text === '/list') {
    const out = cars.slice(0, 20).map(c => `${c.brand} ${c.model}, ${c.year} — ${c.price} ${CUR} [${c.status}]\n/sold_${c.id}  /stock_${c.id}  /del_${c.id}`).join('\n\n');
    return say(chat, out || 'Каталог порожній. /add', noKb);
  }
  if ((mm = text.match(/^\/(sold|stock|del|delyes)_(\w+)/))) {
    const c = cars.find(x => x.id === mm[2]);
    if (!c) return say(chat, 'Авто не знайдено.');
    if (mm[1] === 'del') return say(chat, `Видалити ${c.brand} ${c.model}? Підтвердіть: /delyes_${c.id}`);
    if (mm[1] === 'delyes') { cars = cars.filter(x => x !== c); rmPhotos(c); await save(); return say(chat, 'Видалено.'); }
    c.status = mm[1]; await save();
    return say(chat, `${c.brand} ${c.model}: ${mm[1] === 'sold' ? 'продано' : 'в наявності'}.`);
  }
  if ((mm = text.match(/^\/price\s+(\w+)\s+(\S+)/))) {
    const c = cars.find(x => x.id === mm[1]), p = parseNum(mm[2]);
    if (!c || !p) return say(chat, 'Формат: /price ID 85000');
    c.price = p; await save();
    return say(chat, `${c.brand} ${c.model}: ${p} ${CUR}.`);
  }

  const s = sess.get(chat);
  if (!s) return say(chat, HELP);
  const st = STEPS[s.i];

  if (st.k === 'photos') {
    if (m.photo) {
      const p = m.photo[m.photo.length - 1];   // найбільший розмір
      s.photos.push(await savePhoto(p.file_id, s.car.id, s.photos.length + 1));
      if (!m.media_group_id || m.media_group_id !== s.grp) await say(chat, 'Фото додано. Надішліть ще або натисніть «Готово».');
      s.grp = m.media_group_id;
      return;
    }
    if (/^(готово|без фото)$/i.test(text)) return finish(chat, s);
    return say(chat, 'Надішліть фото або натисніть «Готово».');
  }

  let v = null;
  if (st.opts) v = st.opts.find(o => o.toLowerCase() === text.toLowerCase()) || null;
  else if (st.num) { v = parseNum(text); if (v != null && (v < st.num[0] || v > st.num[1])) v = null; }
  else if (text && text.length <= 60) v = text;
  if (v == null) return say(chat, 'Не зрозумів. ' + st.q);

  if (st.k === 'awd') { if (v === 'Так') s.car.awd = true; }
  else s.car[st.k] = st.k === 'status' ? STATUS[v] : v;
  s.i++;
  return ask(chat, s);
}

async function poll() {
  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      if (!r.ok) throw new Error(JSON.stringify(r));
      for (const u of r.result) {
        offset = u.update_id + 1;
        if (u.message) await onMessage(u.message).catch(e => console.error('bot:', e.message));
      }
    } catch (e) {
      console.error('poll:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ===== Старт: спочатку завантажуємо каталог, потім приймаємо запити =====
(async () => {
  try { await loadCars(); }
  catch (e) {
    // не стартуємо з порожнім списком, щоб випадково не перезаписати каталог у хмарі
    console.error(e.message);
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`AutoHub: http://localhost:${PORT}  (авто: ${cars.length}, бот: ${BOT_TOKEN ? 'увімкнено' : 'вимкнено'}, сховище: ${CLD ? 'Cloudinary' : 'локальне'})`));
  if (BOT_TOKEN) poll(); else console.warn('BOT_TOKEN не задано — бот вимкнено');
})();
