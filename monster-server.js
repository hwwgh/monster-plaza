// 妖怪冒险「多人广场」联机服务器（零依赖，内存态）
// 本地启动：node server/monster-server.js
// 云端启动：PORT=8420 node server/monster-server.js（端口由平台注入）
//
// 交易规则（协商制）：
//   1. 卖家把背包道具挂上摊位（/list，最多 3 件）
//   2. 买家（需求方）对物品发起交易（/offer，附出价）
//   3. 卖家收到通知，可直接同意（/agree），或修改价格（/price）后等买家确认
//   4. 双方同意后交易成功（/agree），服务器向双方推送交割事件（kind=deal）
const http = require('http');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8420;
const ONLINE_TTL_MS = 30 * 1000;
const CHAT_KEEP = 50;
const EVENT_KEEP = 20;
const OFFER_TTL_MS = 10 * 60 * 1000;
const MAX_LISTINGS = 3;

const players = new Map();   // pid -> { pid, name, level, coins, area, items: [{id, name, price}], lastSeen }
const mailboxes = new Map(); // pid -> events[]
const chat = [];             // { ts, name, text }
const offers = new Map();    // offerId -> offer

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

function pruneOffers() {
  const t = now();
  for (const [id, offer] of offers) {
    if (offer.status === 'deal' || offer.status === 'closed' || t - offer.ts > OFFER_TTL_MS) {
      offers.delete(id);
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

function allListings() {
  prunePlayers();
  const list = [];
  for (const player of players.values()) {
    const items = Array.isArray(player.items) ? player.items : [];
    for (const item of items) {
      list.push({
        sellerPid: player.pid,
        sellerName: player.name,
        itemId: item.id,
        itemName: item.name,
        price: item.price
      });
    }
  }
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

function newOfferId() {
  return 'o_' + now().toString(36) + Math.random().toString(36).slice(2, 8);
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
      pruneOffers();
      return send(res, 200, {
        ok: true,
        online: players.size,
        chat: chat.length,
        offers: offers.size
      });
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
      const existing = players.get(pid);
      players.set(pid, {
        pid: pid,
        name: str(body.name, 20, '无名小妖'),
        level: num(body.level, 1, 999, 1),
        coins: num(body.coins, 0, 999999999, 0),
        area: str(body.area, 30, '未知地界'),
        items: existing && Array.isArray(existing.items) ? existing.items : [],
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
      pruneOffers();
      return send(res, 200, {
        ok: true,
        online: players.size,
        players: onlinePlayers(pid),
        events: takeEvents(pid),
        chat: chat.slice(-CHAT_KEEP),
        listings: allListings()
      });
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

    // ===== 摆摊与协商交易 =====

    if (url === '/list') {
      const self = players.get(pid);
      if (!self) {
        return send(res, 400, { ok: false, error: 'pid' });
      }
      const itemId = num(body.itemId, 1, 9999, 0);
      const itemName = str(body.itemName, 20, '');
      const price = num(body.price, 1, 99999, 0);
      if (!itemId || !itemName || !price) {
        return send(res, 400, { ok: false, error: 'item' });
      }
      if (!Array.isArray(self.items)) {
        self.items = [];
      }
      const rest = self.items.filter((it) => it.id !== itemId);
      if (rest.length >= MAX_LISTINGS) {
        return send(res, 400, { ok: false, error: 'full' });
      }
      rest.push({ id: itemId, name: itemName, price: price });
      self.items = rest;
      self.lastSeen = now();
      return send(res, 200, { ok: true });
    }

    if (url === '/unlist') {
      const self = players.get(pid);
      if (self) {
        const itemId = num(body.itemId, 0, 9999, 0);
        if (Array.isArray(self.items)) {
          self.items = self.items.filter((it) => it.id !== itemId);
        }
        self.lastSeen = now();
      }
      return send(res, 200, { ok: true });
    }

    if (url === '/offer') {
      const buyer = players.get(pid);
      const toId = str(body.toId, 64, '');
      const seller = players.get(toId);
      if (!buyer || !seller) {
        return send(res, 400, { ok: false, error: 'pid' });
      }
      const itemId = num(body.itemId, 1, 9999, 0);
      const price = num(body.price, 1, 99999, 0);
      const listing = (Array.isArray(seller.items) ? seller.items : []).find((it) => it.id === itemId);
      if (!itemId || !price || !listing) {
        return send(res, 400, { ok: false, error: 'item' });
      }
      pruneOffers();
      for (const offer of offers.values()) {
        if (offer.buyerPid === pid && offer.sellerPid === toId && offer.itemId === itemId
          && offer.status !== 'deal' && offer.status !== 'closed') {
          return send(res, 400, { ok: false, error: 'dup' });
        }
      }
      const offerId = newOfferId();
      offers.set(offerId, {
        id: offerId,
        itemId: listing.id,
        itemName: listing.name,
        price: price,
        sellerPid: toId,
        sellerName: seller.name,
        buyerPid: pid,
        buyerName: buyer.name,
        status: 'wait_seller',
        ts: now()
      });
      pushEvent(toId, {
        kind: 'offer',
        offerId: offerId,
        itemId: listing.id,
        itemName: listing.name,
        price: price,
        from: buyer.name,
        fromPid: pid,
        ts: now()
      });
      buyer.lastSeen = now();
      return send(res, 200, { ok: true });
    }

    if (url === '/price') {
      const offer = offers.get(str(body.offerId, 64, ''));
      const price = num(body.price, 1, 99999, 0);
      if (!offer || offer.status !== 'wait_seller' || offer.sellerPid !== pid || !price) {
        return send(res, 400, { ok: false, error: 'offer' });
      }
      offer.price = price;
      offer.status = 'wait_buyer';
      offer.ts = now();
      pushEvent(offer.buyerPid, {
        kind: 'counter',
        offerId: offer.id,
        itemId: offer.itemId,
        itemName: offer.itemName,
        price: price,
        from: offer.sellerName,
        ts: now()
      });
      const self = players.get(pid);
      if (self) {
        self.lastSeen = now();
      }
      return send(res, 200, { ok: true });
    }

    if (url === '/agree') {
      const offer = offers.get(str(body.offerId, 64, ''));
      if (!offer) {
        return send(res, 400, { ok: false, error: 'offer' });
      }
      let agreed = false;
      if (offer.status === 'wait_seller' && offer.sellerPid === pid) {
        agreed = true;
      }
      if (offer.status === 'wait_buyer' && offer.buyerPid === pid) {
        agreed = true;
      }
      if (!agreed) {
        return send(res, 400, { ok: false, error: 'turn' });
      }
      const seller = players.get(offer.sellerPid);
      if (seller && Array.isArray(seller.items)) {
        seller.items = seller.items.filter((it) => it.id !== offer.itemId);
      }
      offer.status = 'deal';
      offer.ts = now();
      pushEvent(offer.buyerPid, {
        kind: 'deal', offerId: offer.id, itemId: offer.itemId, itemName: offer.itemName,
        price: offer.price, role: 'buyer', peer: offer.sellerName, ts: now()
      });
      pushEvent(offer.sellerPid, {
        kind: 'deal', offerId: offer.id, itemId: offer.itemId, itemName: offer.itemName,
        price: offer.price, role: 'seller', peer: offer.buyerName, ts: now()
      });
      const self = players.get(pid);
      if (self) {
        self.lastSeen = now();
      }
      return send(res, 200, { ok: true });
    }

    if (url === '/reject') {
      const offer = offers.get(str(body.offerId, 64, ''));
      if (!offer || (offer.sellerPid !== pid && offer.buyerPid !== pid)) {
        return send(res, 400, { ok: false, error: 'offer' });
      }
      const otherPid = offer.sellerPid === pid ? offer.buyerPid : offer.sellerPid;
      const myName = offer.sellerPid === pid ? offer.sellerName : offer.buyerName;
      offer.status = 'closed';
      offer.ts = now();
      pushEvent(otherPid, {
        kind: 'reject',
        offerId: offer.id,
        itemName: offer.itemName,
        peer: myName,
        ts: now()
      });
      const self = players.get(pid);
      if (self) {
        self.lastSeen = now();
      }
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
