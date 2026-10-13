const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const root = __dirname;
const INACTIVE_LIMIT_MS = 90_000;
const conditions = { A: { public: false, bonus: false }, B: { public: true, bonus: false }, C: { public: false, bonus: true }, D: { public: true, bonus: true } };

function token() { return crypto.randomBytes(24).toString('hex'); }
function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
  return code;
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function fail(res, status, error) { json(res, status, { error }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 16_384) { reject(new Error('요청이 너무 큽니다.')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('요청 형식이 올바르지 않습니다.')); } });
    req.on('error', reject);
  });
}
function validName(value, fallback) {
  const name = String(value || '').trim().slice(0, 30);
  return name || fallback;
}
function auth(room, key) {
  const player = room.players.find(p => p.token === key);
  if (!player) return null;
  return { role: player.id === room.hostId ? 'host' : 'player', player };
}
function removePlayer(room, player) {
  const index = room.players.findIndex(item => item.id === player.id);
  if (index < 0) return;
  room.players.splice(index, 1);
  if (room.round?.phase === 'playing') {
    room.round.submissions.delete(player.id);
    if (room.players.length > 0) completeRound(room);
  }
  if (room.hostId === player.id) room.hostId = room.players[0]?.id || null;
  if (room.players.length === 0) rooms.delete(room.code);
}
function pruneInactivePlayers() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    for (const player of [...room.players]) {
      if (now - player.lastSeen > INACTIVE_LIMIT_MS) removePlayer(room, player);
    }
  }
}
function currentScore(player) { return player.balance + player.rewardScore; }
function completeRound(room) {
  const round = room.round;
  if (round.phase !== 'playing' || round.submissions.size !== room.players.length) return;
  const total = [...round.submissions.values()].reduce((sum, item) => sum + item.value, 0);
  const returned = 1.5 * total / 4;
  const bonus = conditions[round.condition].bonus && total >= 24 ? 3 : 0;
  const players = room.players.map(player => {
    const contribution = round.submissions.get(player.id).value;
    player.rewardScore += returned + bonus;
    return { id: player.id, name: player.name, contribution, balance: player.balance, rewardScore: player.rewardScore, score: currentScore(player) };
  });
  round.total = total; round.returned = returned; round.bonus = bonus; round.players = players; round.phase = 'result';
  room.history.push({ number: round.number, condition: round.condition, total, returned, bonus, players });
}
function view(room, access) {
  const history = room.history.map(item => ({
    number: item.number, condition: item.condition, total: item.total, returned: item.returned, bonus: item.bonus,
    players: conditions[item.condition].public
      ? item.players.map(p => ({ name: p.name, contribution: p.contribution, balance: p.balance, score: p.score }))
      : [item.players.find(p => p.id === access.player.id)].filter(Boolean).map(p => ({ name: p.name, contribution: null, balance: p.balance, score: p.score }))
  }));
  const result = { code: room.code, role: access.role, phase: room.round ? room.round.phase : 'lobby', players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })), round: null, history };
  if (!room.round) return result;
  const r = room.round;
  if (r.phase === 'playing') {
    const own = r.submissions.get(access.player.id);
    result.round = {
      number: r.number, condition: r.condition, public: conditions[r.condition].public,
      submittedCount: r.submissions.size, mineSubmitted: Boolean(own),
      myBalance: access.player.balance, myScore: currentScore(access.player),
      submissions: conditions[r.condition].public ? room.players.map(p => ({ name: p.name, value: r.submissions.has(p.id) ? r.submissions.get(p.id).value : null })) : []
    };
    return result;
  }
  const mine = r.players.find(p => p.id === access.player.id);
  result.round = {
    number: r.number, condition: r.condition, public: conditions[r.condition].public,
    total: r.total, returned: r.returned, bonus: r.bonus,
    finished: r.number >= 5,
    myBalance: access.player.balance, myScore: mine ? mine.score : null,
    players: conditions[r.condition].public ? r.players.map(p => ({ name: p.name, contribution: p.contribution, balance: p.balance, score: p.score })) : []
  };
  return result;
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const data = await readBody(req); const code = roomCode(); const hostToken = token(); const hostId = token();
    const host = { id: hostId, token: hostToken, name: validName(data.name, '방장'), lastSeen: Date.now() };
    const room = { code, hostToken, hostId, players: [host], round: null, nextNumber: 1, history: [] };
    rooms.set(code, room);
    return json(res, 201, { code, token: hostToken });
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const data = await readBody(req); const code = String(data.code || '').trim().toUpperCase(); const room = rooms.get(code);
    if (!room) return fail(res, 404, '방을 찾을 수 없습니다. 코드를 확인해 주세요.');
    if (room.round) return fail(res, 409, '이미 시작된 방에는 참가할 수 없습니다.');
    if (room.players.length >= 4) return fail(res, 409, '방장 포함 최대 네 명까지 참가할 수 있습니다.');
    const player = { id: token(), token: token(), name: validName(data.name, `참가자 ${room.players.length + 1}`), lastSeen: Date.now() };
    room.players.push(player);
    return json(res, 201, { code, token: player.token });
  }
  if (req.method === 'POST' && url.pathname === '/api/leave') {
    const data = await readBody(req); const room = rooms.get(String(data.code || '').toUpperCase());
    if (!room) return json(res, 200, { ok: true });
    const access = auth(room, data.token);
    if (!access) return json(res, 200, { ok: true });
    removePlayer(room, access.player);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/kick') {
    const data = await readBody(req); const room = rooms.get(String(data.code || '').toUpperCase());
    if (!room) return fail(res, 404, '방을 찾을 수 없습니다.');
    const access = auth(room, data.token);
    if (!access) return fail(res, 403, '이 방에 접근할 수 없습니다.');
    if (access.role !== 'host') return fail(res, 403, '방장만 참가자를 내보낼 수 있습니다.');
    const target = room.players.find(player => player.id === data.playerId);
    if (!target || target.id === room.hostId) return fail(res, 404, '내보낼 참가자를 찾을 수 없습니다.');
    removePlayer(room, target);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/room') {
    const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
    if (!room) return fail(res, 404, '방을 찾을 수 없습니다.');
    const access = auth(room, url.searchParams.get('token'));
    if (!access) return fail(res, 403, '이 방에 접근할 수 없습니다.');
    access.player.lastSeen = Date.now();
    return json(res, 200, view(room, access));
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
    if (!room) return fail(res, 404, '방을 찾을 수 없습니다.');
    const access = auth(room, url.searchParams.get('token'));
    if (!access) return fail(res, 403, '이 방에 접근할 수 없습니다.');
    access.player.lastSeen = Date.now();
    return json(res, 200, { history: view(room, access).history });
  }
  if (req.method === 'POST' && ['/api/start', '/api/contribute', '/api/next'].includes(url.pathname)) {
    const data = await readBody(req); const room = rooms.get(String(data.code || '').toUpperCase());
    if (!room) return fail(res, 404, '방을 찾을 수 없습니다.');
    const access = auth(room, data.token);
    if (!access) return fail(res, 403, '이 방에 접근할 수 없습니다.');
    access.player.lastSeen = Date.now();
    if (url.pathname === '/api/start') {
      if (access.role !== 'host') return fail(res, 403, '방장만 실험을 시작할 수 있습니다.');
      if (room.round || room.players.length < 2) return fail(res, 409, '방장 포함 두 명 이상 모인 뒤 시작할 수 있습니다.');
      if (!conditions[data.condition]) return fail(res, 400, '실험 조건을 확인해 주세요.');
      for (const player of room.players) { player.balance = 10; player.rewardScore = 0; }
      room.round = { number: room.nextNumber++, condition: data.condition, phase: 'playing', submissions: new Map() };
    } else if (url.pathname === '/api/contribute') {
      if (!room.round || room.round.phase !== 'playing') return fail(res, 409, '현재 진행 중인 회차가 없습니다.');
      const value = Number(data.value);
      if (!Number.isInteger(value) || value < 0 || value > access.player.balance) return fail(res, 400, `기여량은 현재 보유한 ${access.player.balance}포인트 이하여야 합니다.`);
      if (room.round.submissions.has(access.player.id)) return fail(res, 409, '이미 기여량을 제출했습니다.');
      access.player.balance -= value;
      room.round.submissions.set(access.player.id, { value }); completeRound(room);
    } else {
      if (access.role !== 'host') return fail(res, 403, '방장만 다음 회차를 시작할 수 있습니다.');
      if (!room.round || room.round.phase !== 'result') return fail(res, 409, '현재 회차 결과가 아직 나오지 않았습니다.');
      if (room.round.number >= 5) return fail(res, 409, '게임은 5회차까지 진행할 수 있습니다.');
      if (!conditions[data.condition]) return fail(res, 400, '실험 조건을 확인해 주세요.');
      room.round = { number: room.nextNumber++, condition: data.condition, phase: 'playing', submissions: new Map() };
    }
    return json(res, 200, { ok: true });
  }
  return fail(res, 404, 'API 경로를 찾을 수 없습니다.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '지원하지 않는 요청입니다.');
    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(root, requested);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, '페이지를 찾을 수 없습니다.');
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    if (!res.headersSent) fail(res, 400, error.message || '요청을 처리할 수 없습니다.');
  }
});

setInterval(pruneInactivePlayers, 10_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`협력 게임 서버 실행 중: http://localhost:${PORT}`);
  console.log('같은 Wi-Fi의 친구는 방장 기기의 내부 IP 주소와 포트 3000으로 접속할 수 있습니다.');
});

