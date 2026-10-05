// Запуск: BOT_TOKEN=... CHAT_ID=... node server.js   (потрібен Node 18+, залежності не потрібні)
const http = require('http');
const fs = require('fs');
const path = require('path');

const { BOT_TOKEN, CHAT_ID, PORT = 3000 } = process.env;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function handleLead(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) return send(res, 413, { ok: false });
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
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    });
    if (!r.ok) throw new Error(await r.text());
    send(res, 200, { ok: true });
  } catch (e) {
    console.error('Telegram error:', e.message);
    send(res, 502, { ok: false });
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/lead') return handleLead(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false });

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, path.normalize(rel));
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!file.startsWith(ROOT + path.sep) || !type) return send(res, 404, 'Not found', 'text/plain');

  fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, type));
}).listen(PORT, () => console.log(`AutoHub: http://localhost:${PORT}`));
