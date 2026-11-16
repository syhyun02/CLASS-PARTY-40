import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { DT, TICK_RATE, type CreateReq, type CreateRes, type HostCmd, type InputMsg, type JoinReq, type JoinRes } from '@shared';
import { metrics, recordTick, tickStats } from './metrics';
import { Room } from './room';

const PORT = Number(process.env.PORT ?? 3001);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

await RAPIER.init();

const app = express();
const http = createServer(app);
const io = new Server(http, {
  cors: { origin: true },
  pingInterval: 10_000,
  pingTimeout: 8_000,
  perMessageDeflate: false, // 작은 메시지를 자주 보내므로 압축은 CPU만 쓴다
});

const rooms = new Map<string, Room>();

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
    const room = new Room(io, RAPIER, code, { mode: cfg.mode === 'chem' ? 'chem' : 'play', rounds: cfg.rounds, games: [...(cfg.games ?? [])] });
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
    if (room && socket.data.host && cmd && typeof cmd.type === 'string') room.hostCmd(cmd);
  });

  socket.on('join', (req: JoinReq, ack: (r: JoinRes) => void) => {
    if (typeof ack !== 'function') return;
    const room = rooms.get(String(req?.code ?? '').trim());
    if (!room) return ack({ ok: false, error: '입장 코드를 다시 확인해 주세요.' });
    ack(room.join(socket, req));
  });

  socket.on('in', (msg: InputMsg) => {
    const id = socket.data.playerId as number | undefined;
    if (id !== undefined) roomOf()?.onInput(id, msg);
  });

  socket.on('color', (c: string) => {
    const id = socket.data.playerId as number | undefined;
    if (id !== undefined && typeof c === 'string') roomOf()?.setColor(id, c);
  });

  // 지연 측정 + 시계 동기화용
  socket.on('pg', (t: number, ack: (t: number, tick: number) => void) => {
    if (typeof ack === 'function') ack(t, roomOf()?.tick ?? 0);
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
  if (now - next > 10) metrics.lateTicks++;
  let guard = 0;
  while (now >= next && guard++ < 5) {
    const t0 = performance.now();
    for (const room of rooms.values()) room.step();
    recordTick(performance.now() - t0);
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

http.listen(PORT, '0.0.0.0', () => {
  console.log(`CLASS PARTY 40 서버 실행 중 (포트 ${PORT}, ${TICK_RATE}Hz)`);
  for (const ip of lanAddresses()) console.log(`  같은 Wi-Fi의 기기에서: http://${ip}:${clientDist ? PORT : 5173}`);
  if (!clientDist) console.log('  (개발 모드: 화면은 Vite 개발 서버 5173 포트에서 열립니다)');
});
