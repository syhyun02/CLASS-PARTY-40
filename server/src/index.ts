import compression from 'compression';
import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { DT, TICK_RATE, type CreateReq, type CreateRes, type HostCmd, type JoinReq, type JoinRes } from '@shared';
import { metrics, recordTick, tickStats } from './metrics';
import { Room } from './room';

const PORT = Number(process.env.PORT ?? 3001);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

await RAPIER.init();

const app = express();
app.use(compression()); // 자바스크립트 묶음과 물리 엔진(WASM) 전송량을 줄인다
app.get('/healthz', (_req, res) => res.send('ok')); // 배포 서비스의 상태 확인용
const http = createServer(app);
const io = new Server(http, {
  cors: { origin: true },
  pingInterval: 10_000,
  pingTimeout: 8_000,
  perMessageDeflate: false, // 작은 메시지를 자주 보내므로 압축은 CPU만 쓴다
});

const rooms = new Map<string, Room>();
const lateTimes: number[] = []; // 늦게 시작한 틱의 시각(서버가 버거운지 판단하는 용도)
let recentTickMs = 0;

function newCode(): string {
  for (;;) {
    const c = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(c)) return c;
  }
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

app.get('/api/info', (_req, res) => res.json({ lan: lanAddresses(), port: PORT }));
app.get('/api/metrics', (_req, res) => {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  let players = 0;
  for (const r of rooms.values()) players += r.connectedCount;
  res.json({
    rooms: rooms.size, players, sockets: io.engine.clientsCount,
    tick: tickStats(), ticks: metrics.ticks, lateTicks: metrics.lateTicks,
    bytesOut: metrics.bytesOut, snapshots: metrics.snapshots,
    inputs: metrics.inputs, guessed: metrics.guessed, dropped: metrics.dropped, idle: metrics.idle,
    cpuMs: (cpu.user + cpu.system) / 1000, rssMb: mem.rss / 1048576, heapMb: mem.heapUsed / 1048576,
    uptime: process.uptime(),
  });
});

// 빌드된 클라이언트가 있으면 같은 포트에서 함께 제공한다(배포용)
const clientDist = [path.resolve(__dirname, '../../client/dist'), path.resolve(__dirname, '../client/dist')].find((p) => fs.existsSync(p));
if (clientDist) {
  app.use(express.static(clientDist, { maxAge: '1h', index: false }));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

io.on('connection', (socket) => {
  const roomOf = () => rooms.get(socket.data.code as string);

  socket.on('host:create', (req: CreateReq, ack: (r: CreateRes) => void) => {
    if (typeof ack !== 'function') return;
    if (rooms.size >= 50) return ack({ ok: false, error: '서버에 방이 너무 많아요.' });
    const code = newCode();
    const cfg = req?.config ?? { mode: 'play', rounds: 10, games: [] };
    const room = new Room(io, RAPIER, code, {
      mode: cfg.mode === 'chem' ? 'chem' : 'play', rounds: cfg.rounds, games: [...(cfg.games ?? [])],
      chem: cfg.chem, studentSound: cfg.studentSound, // 출제 범위와 소리 설정도 방 만들 때 값 그대로(방에서 검사한다)
    });
    rooms.set(code, room);
    attachHost(room);
    ack({ ok: true, code, hostToken: room.hostToken });
  });

  socket.on('host:resume', (req: { code: string; hostToken: string }, ack: (r: CreateRes) => void) => {
    if (typeof ack !== 'function') return;
    const room = rooms.get(req?.code);
    if (!room || room.hostToken !== req.hostToken) return ack({ ok: false, error: '방을 찾을 수 없어요.' });
    attachHost(room);
    ack({ ok: true, code: room.code, hostToken: room.hostToken });
  });

  function attachHost(room: Room) {
    socket.data.code = room.code;
    socket.data.host = true;
    room.hosts.add(socket.id);
    socket.join(room.channel);
    socket.emit('room', room.snapshotState());
  }

  socket.on('host:cmd', (cmd: HostCmd) => {
    const room = roomOf();
    if (!room || !socket.data.host || !cmd || typeof cmd.type !== 'string') return;
    if (cmd.type === 'close') {
      // 교사가 방을 닫았다: 학생과 다른 교사 화면을 모두 내보내고 방을 지운다
      rooms.delete(room.code);
      room.close();
      for (const id of room.hosts) { const hs = io.sockets.sockets.get(id); if (hs) { hs.leave(room.channel); hs.data.host = false; hs.data.code = undefined; } }
      return;
    }
    room.hostCmd(cmd);
  });

  socket.on('join', (req: JoinReq, ack: (r: JoinRes) => void) => {
    if (typeof ack !== 'function') return;
    const room = rooms.get(String(req?.code ?? '').trim());
    if (!room) return ack({ ok: false, error: '입장 코드를 다시 확인해 주세요.' });
    ack(room.join(socket, req));
  });

  socket.on('in', (msg: number[]) => {
    const id = socket.data.playerId as number | undefined;
    if (id !== undefined) roomOf()?.onInput(id, msg);
  });

  socket.on('color', (c: string) => {
    const id = socket.data.playerId as number | undefined;
    if (id !== undefined && typeof c === 'string') roomOf()?.setColor(id, c);
  });

  // 지연 측정 + 시계 동기화용
  // 지연 측정 + 서버 상태: 최근 5초 동안 늦게 돈 틱 수와 틱 처리 시간을 함께 알려 준다
  socket.on('pg', (t: number, ack: (t: number, tick: number, late: number, tickMs: number) => void) => {
    if (typeof ack !== 'function') return;
    const now = performance.now();
    while (lateTimes.length && now - lateTimes[0] > 5000) lateTimes.shift();
    ack(t, roomOf()?.tick ?? 0, lateTimes.length, recentTickMs);
  });

  socket.on('disconnect', () => {
    const room = roomOf();
    if (!room) return;
    room.hosts.delete(socket.id);
    room.leave(socket);
  });
});

// ---- 고정 틱 루프: setTimeout 오차를 누적하지 않도록 예정 시각 기준으로 돈다 ----
const stepMs = DT * 1000;
let next = performance.now() + stepMs;
function loop() {
  const now = performance.now();
  if (now - next > stepMs * 0.6) { metrics.lateTicks++; lateTimes.push(now); if (lateTimes.length > 600) lateTimes.shift(); }
  let guard = 0;
  while (now >= next && guard++ < 5) {
    const t0 = performance.now();
    for (const room of rooms.values()) {
      // 한 방에서 오류가 나도 서버와 다른 방은 계속 돌아가게 한다
      try { room.step(); room.faults = 0; } catch (e) {
        console.error(`방 ${room.code} 틱 오류:`, e);
        if (++room.faults >= 3) { try { room.recover(); } catch (e2) { console.error('복구 실패, 방을 닫습니다:', e2); rooms.delete(room.code); } }
      }
    }
    const took = performance.now() - t0;
    recentTickMs += (took - recentTickMs) * 0.02;
    recordTick(took);
    next += stepMs;
  }
  if (now - next > 500) next = now + stepMs; // 크게 밀리면 따라잡지 않고 재설정
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();

// 30분 동안 아무도 없는 방은 정리한다
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.connectedCount > 0 || room.hosts.size > 0) { room.lastActive = now; continue; }
    if (now - room.lastActive > 30 * 60_000) { room.dispose(); rooms.delete(code); }
  }
}, 60_000);

// 배포 서비스가 재시작할 때 연결을 정리하고 끝낸다
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { io.close(); http.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
}
process.on('uncaughtException', (e) => console.error('처리되지 않은 오류:', e));
process.on('unhandledRejection', (e) => console.error('처리되지 않은 거부:', e));

http.listen(PORT, '0.0.0.0', () => {
  console.log(`CLASS PARTY 40 서버 실행 중 (포트 ${PORT}, ${TICK_RATE}Hz)`);
  for (const ip of lanAddresses()) console.log(`  같은 Wi-Fi의 기기에서: http://${ip}:${clientDist ? PORT : 5173}`);
  if (!clientDist) console.log('  (개발 모드: 화면은 Vite 개발 서버 5173 포트에서 열립니다)');
});
