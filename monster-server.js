// 妖怪冒险「多人广场」联机服务器（零依赖，内存态）
// 本地启动：node server/monster-server.js
// 云端启动：PORT=8420 node server/monster-server.js（端口由平台注入）
const http = require('http');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8420;
const ONLINE_TTL_MS = 30 * 1000;
const CHAT_KEEP = 50;
const EVENT_KEEP = 20;

const players = new Map();   // pid -> { pid, name, level, coins, area, lastSeen }
const mailboxes = new Map(); // pid -> events[]
const chat = [];             // { ts, name, text }

function now() {
  return Date.now();
}

function str(value, max, fallback) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : fallback;
}

function num(value, min, max, fallback) {
  if (typeof value !== 'number' || !isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function prunePlayers() {
  const t = now();
  for (const [pid, player] of players) {
    if (t - player.lastSeen > ONLINE_TTL_MS) {
      players.delete(pid);
    }
  }
}

function onlinePlayers(exceptPid) {
  prunePlayers();
  const list = [];
  for (const player of players.values()) {
    if (player.pid !== exceptPid) {
      list.push({
        pid: player.pid,
        name: player.name,
        level: player.level,
        coins: player.coins,
        area: player.area
      });
    }
  }
  list.sort((a, b) => b.level - a.level || b.coins - a.coins);
  return list;
}

function takeEvents(pid) {
  const events = mailboxes.get(pid) || [];
  mailboxes.delete(pid);
  return events;
}

function pushEvent(pid, event) {
  const box = mailboxes.get(pid) || [];
  box.push(event);
  while (box.length > EVENT_KEEP) {
    box.shift();
  }
  mailboxes.set(pid, box);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 65536) {
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (req.method === 'GET' && url === '/health') {
      prunePlayers();
      return send(res, 200, { ok: true, online: players.size, chat: chat.length });
    }
    if (req.method !== 'POST') {
      return send(res, 405, { ok: false, error: 'method' });
    }
    const body = await readBody(req);
    const pid = str(body.pid, 64, '');
    if (url === '/join') {
      if (!pid) {
        return send(res, 400, { ok: false, error: 'pid' });
      }
      players.set(pid, {
        pid: pid,
        name: str(body.name, 20, '无名小妖'),
        level: num(body.level, 1, 999, 1),
        coins: num(body.coins, 0, 999999999, 0),
        area: str(body.area, 30, '未知地界'),
        lastSeen: now()
      });
      prunePlayers();
      return send(res, 200, { ok: true, online: players.size });
    }
    if (url === '/leave') {
      if (pid) {
        players.delete(pid);
        mailboxes.delete(pid);
      }
      return send(res, 200, { ok: true });
    }
    if (url === '/poll') {
      if (!pid) {
        return send(res, 400, { ok: false, error: 'pid' });
      }
      const self = players.get(pid);
      if (self) {
        self.lastSeen = now();
      }
      prunePlayers();
      return send(res, 200, {
        ok: true,
        online: players.size,
        players: onlinePlayers(pid),
        events: takeEvents(pid),
        chat: chat.slice(-CHAT_KEEP)
      });
    }
    if (url === '/gift') {
      const fromId = str(body.fromId, 64, '');
      const toId = str(body.toId, 64, '');
      if (!fromId || !toId || !players.has(toId)) {
        return send(res, 400, { ok: false, error: 'target' });
      }
      const amount = num(body.amount, 1, 500, 0);
      if (amount <= 0) {
        return send(res, 400, { ok: false, error: 'amount' });
      }
      const from = players.get(fromId);
      pushEvent(toId, {
        kind: 'coin',
        from: from ? from.name : str(body.fromName, 20, '无名小妖'),
        amount: amount,
        msg: str(body.msg, 40, ''),
        ts: now()
      });
      if (from) {
        from.lastSeen = now();
      }
      return send(res, 200, { ok: true });
    }
    if (url === '/say') {
      if (!pid || !players.has(pid)) {
        return send(res, 400, { ok: false, error: 'pid' });
      }
      const self = players.get(pid);
      const text = str(body.text, 60, '');
      if (!text) {
        return send(res, 400, { ok: false, error: 'text' });
      }
      chat.push({ ts: now(), name: self.name, text: text });
      while (chat.length > CHAT_KEEP) {
        chat.shift();
      }
      self.lastSeen = now();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: 'notfound' });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'server' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`monster plaza server listening on 0.0.0.0:${PORT}`);
});
