import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Server, Socket } from 'socket.io';
import {
  COUNTDOWN_SEC, DT, FLAG_ACT, FLAG_DONE, FLAG_GROUNDED, FLAG_HIDDEN, FLAG_MOVING, FLAG_STUN, MAX_PLAYERS, NO_INPUT, PLAYER_COLORS, PLAYER_RADIUS,
  SNAPSHOT_EVERY, SimWorld, TICK_RATE, buildLevel, encodeSnapshot, getGame, newPlayerState, packState,
  type HostCmd, type InputMsg, type JoinReq, type JoinRes, type LevelDef, type Phase, type PlayerInput,
  type PlayerState, type RoomConfig, type RoomState, type RoundRow, type SelfMsg, type SnapPlayer,
} from '@shared';
import { drawGame, getMinigame, playableIds } from './minigames';
import type { GameCtx, GamePlayer, MinigameRuntime } from './minigames/types';
import { metrics } from './metrics';

const sec = (s: number) => Math.round(s * TICK_RATE);
const DRAW_TICKS = sec(6);
const COUNTDOWN_TICKS = sec(COUNTDOWN_SEC);
const RESULT_TICKS = sec(12);
const MAX_QUEUE = 8;

class Player implements GamePlayer {
  socket: Socket | null = null;
  score = 0;
  state: PlayerState;
  queue: InputMsg[] = [];
  input: PlayerInput = { ...NO_INPUT };
  lastSeq = 0;
  starve = 0; // 입력이 안 온 연속 틱
  tokens = 2;
  active = true;
  done = false;
  out = false;
  pushAt = -999;
  place: number | null = null;
  leftAt = 0;
  constructor(public id: number, public token: string, public name: string, public color: string, level: LevelDef) {
    this.state = newPlayerState(level, id);
  }
  get connected() { return this.socket !== null; }
}

export class Room {
  readonly players = new Map<number, Player>();
  readonly hostToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  hosts = new Set<string>();
  phase: Phase = 'lobby';
  paused = false;
  tick = 0;
  round = 0;
  gameId: string | null = null;
  private level: LevelDef;
  private sim: SimWorld;
  private levelId = 'lobby';
  private levelSeed = 0;
  private levelKey = 'lobby:0';
  private levelTick = 0;
  private levelSerial = 0;
  private phaseEndTick = 0;
  private gameStartTick = 0;
  private runtime: MinigameRuntime | null = null;
  private roundPlayers: Player[] = [];
  private lastResult: RoundRow[] | null = null;
  private history: RoomState['history'] = [];
  private drawn: string[] = [];
  private dirty = true;
  private gameState: unknown = null;
  private gameDirty = false;
  lastActive = Date.now();

  constructor(private io: Server, private R: typeof RAPIER_NS, readonly code: string, public config: RoomConfig) {
    this.level = buildLevel('lobby', 0);
    this.sim = new SimWorld(R, this.level);
    this.sanitizeConfig();
  }

  get channel() { return `r:${this.code}`; }
  get connectedCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }

  private sanitizeConfig() {
    const ok = playableIds(this.config.mode);
    this.config.games = this.config.games.filter((g) => ok.includes(g));
    if (this.config.games.length === 0) this.config.games = ok;
    this.config.rounds = Math.max(1, Math.min(20, Math.round(this.config.rounds) || 10));
  }

  // ---------- 입장 / 퇴장 ----------

  join(socket: Socket, req: JoinReq): JoinRes {
    const clean = (req.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10);
    if (!clean) return { ok: false, error: '닉네임을 입력해 주세요.' };
    const color = (PLAYER_COLORS as readonly string[]).includes(req.color) ? req.color : PLAYER_COLORS[0];

    // 1) 같은 토큰 = 같은 기기의 재접속. 기존 연결은 끊는다(중복 접속 방지).
    let p = req.token ? [...this.players.values()].find((x) => x.token === req.token) : undefined;
    // 2) 접속이 끊긴 같은 닉네임이 있으면 그 자리를 이어받는다(브라우저를 완전히 껐다 켠 경우).
    if (!p) p = [...this.players.values()].find((x) => !x.connected && x.name === clean);
    if (p) {
      if (p.socket && p.socket.id !== socket.id) {
        p.socket.emit('replaced');
        p.socket.leave(this.channel);
        p.socket.data.playerId = undefined;
        p.socket.disconnect(true);
      }
    } else {
      if (this.players.size >= MAX_PLAYERS) return { ok: false, error: `방이 가득 찼어요(최대 ${MAX_PLAYERS}명).` };
      let id = 0;
      while (this.players.has(id)) id++;
      // 중복 닉네임은 뒤에 번호를 붙인다
      const names = new Set([...this.players.values()].map((x) => x.name));
      let name = clean, n = 2;
      while (names.has(name)) name = `${clean.slice(0, 8)}${n++}`;
      p = new Player(id, Math.random().toString(36).slice(2) + Date.now().toString(36), name, color, this.level);
      // 게임 도중 입장하면 이번 라운드는 관전, 다음 라운드부터 참가
      p.active = !this.inGame();
      this.players.set(id, p);
    }
    p.socket = socket;
    p.lastSeq = 0; // 새로 접속한 클라이언트는 입력 번호를 1부터 다시 센다
    p.queue.length = 0;
    p.input = { ...NO_INPUT };
    p.starve = 0;
    socket.data.playerId = p.id;
    socket.data.code = this.code;
    socket.join(this.channel);
    this.dirty = true;
    this.lastActive = Date.now();
    socket.emit('room', this.snapshotState());
    if (this.gameState) socket.emit('g', { key: this.levelKey, state: this.gameState });
    return { ok: true, id: p.id, token: p.token, name: p.name, tickRate: TICK_RATE };
  }

  leave(socket: Socket) {
    const id = socket.data.playerId as number | undefined;
    if (id === undefined) return;
    const p = this.players.get(id);
    if (!p || p.socket?.id !== socket.id) return;
    p.socket = null;
    p.leftAt = Date.now();
    p.input = { ...NO_INPUT };
    p.queue.length = 0;
    this.dirty = true;
  }

  onInput(id: number, msg: InputMsg) {
    const p = this.players.get(id);
    if (!p || !Array.isArray(msg) || msg.length < 4) return;
    if (p.queue.length >= MAX_QUEUE) p.queue.shift(); // 밀린 입력은 오래된 것부터 버린다
    p.queue.push(msg);
  }

  setColor(id: number, color: string) {
    const p = this.players.get(id);
    if (p && (PLAYER_COLORS as readonly string[]).includes(color)) { p.color = color; this.dirty = true; }
  }

  // ---------- 교사 명령 ----------

  hostCmd(cmd: HostCmd) {
    this.lastActive = Date.now();
    switch (cmd.type) {
      case 'config':
        if (this.phase === 'lobby') { this.config = cmd.config; this.sanitizeConfig(); }
        break;
      case 'start':
        if (this.phase === 'lobby' && this.players.size > 0) {
          this.round = 0; this.history = []; this.drawn = []; this.lastResult = null;
          for (const p of this.players.values()) p.score = 0;
          this.startDraw();
        }
        break;
      case 'pause': this.paused = true; break;
      case 'resume': this.paused = false; break;
      case 'skip': // 현재 단계를 바로 넘긴다
        if (this.phase === 'playing') this.finishRound();
        else if (this.phaseEndTick) this.phaseEndTick = this.tick;
        break;
      case 'end': // 강제 종료 → 지금까지의 점수로 시상식
        if (this.phase === 'playing') this.finishRound();
        if (this.phase !== 'lobby') this.toFinal();
        this.paused = false;
        break;
      case 'toLobby':
        this.setLevel('lobby', 0);
        this.setPhase('lobby', 0);
        this.round = 0; this.gameId = null; this.lastResult = null;
        for (const p of this.players.values()) { p.active = true; p.done = false; p.out = false; p.place = null; }
        break;
      case 'kick': {
        const p = this.players.get(cmd.id);
        if (p) {
          p.socket?.emit('kicked');
          p.socket?.leave(this.channel);
          if (p.socket) p.socket.data.playerId = undefined;
          this.players.delete(cmd.id);
          this.roundPlayers = this.roundPlayers.filter((x) => x !== p);
        }
        break;
      }
    }
    this.dirty = true;
  }

  // ---------- 진행 ----------

  private inGame() { return this.phase === 'countdown' || this.phase === 'playing' || this.phase === 'result'; }

  private setPhase(phase: Phase, duration: number) {
    this.phase = phase;
    this.phaseEndTick = duration > 0 ? this.tick + duration : 0;
    this.dirty = true;
  }

  private setLevel(levelId: string, seed: number) {
    this.sim.free();
    this.level = buildLevel(levelId, seed);
    this.sim = new SimWorld(this.R, this.level);
    this.levelId = levelId;
    this.levelSeed = seed;
    this.levelKey = `${levelId}:${++this.levelSerial}`;
    this.levelTick = this.tick;
    this.gameState = null;
    this.gameDirty = false;
    for (const p of this.players.values()) {
      p.state = newPlayerState(this.level, p.id);
      p.queue.length = 0;
      p.input = { ...NO_INPUT };
    }
    this.dirty = true;
  }

  private startDraw() {
    this.round++;
    this.gameId = drawGame(this.config.games, this.drawn);
    this.drawn.push(this.gameId);
    if (this.levelId !== 'lobby') this.setLevel('lobby', 0);
    for (const p of this.players.values()) { p.done = false; p.out = false; p.place = null; p.active = true; }
    this.setPhase('draw', DRAW_TICKS);
  }

  private startCountdown() {
    const seed = (Math.random() * 2 ** 31) | 0;
    this.setLevel(this.gameId!, seed);
    this.roundPlayers = [...this.players.values()];
    for (const p of this.roundPlayers) { p.active = true; p.done = false; p.out = false; p.place = null; }
    this.setPhase('countdown', COUNTDOWN_TICKS);
  }

  private startPlaying() {
    const meta = getGame(this.gameId!)!;
    this.gameStartTick = this.tick;
    this.setPhase('playing', sec(meta.timeLimit));
    const room = this;
    const ctx: GameCtx = {
      level: this.level,
      get players() { return room.roundPlayers; },
      elapsed: () => this.tick - this.gameStartTick,
      ticksLeft: () => this.phaseEndTick - this.tick,
      shortenTo: (t) => { this.phaseEndTick = this.tick + t; this.dirty = true; },
      touch: () => { this.dirty = true; },
      levelTime: () => (this.tick - this.levelTick) * DT,
      tick: () => this.tick,
      publish: (st) => { this.gameState = st; this.gameDirty = true; },
    };
    this.runtime = getMinigame(this.gameId!).create(ctx);
  }

  private finishRound() {
    if (!this.runtime) return;
    const outcome = this.runtime.outcome();
    this.runtime = null;
    const rows: RoundRow[] = [];
    for (const o of outcome) {
      const p = this.players.get(o.id);
      if (!p) continue;
      p.score += o.points;
      p.place = o.rank;
      rows.push({ id: p.id, name: p.name, color: p.color, rank: o.rank, points: o.points, detail: o.detail, total: p.score });
    }
    rows.sort((a, b) => a.rank - b.rank);
    this.lastResult = rows;
    this.history.push({ round: this.round, gameId: this.gameId!, rows });
    this.setPhase('result', RESULT_TICKS);
  }

  private toFinal() {
    if (this.levelId !== 'lobby') this.setLevel('lobby', 0);
    for (const p of this.players.values()) { p.active = true; p.done = false; p.out = false; }
    this.setPhase('final', 0);
  }

  private canMove(p: Player): boolean {
    switch (this.phase) {
      case 'lobby': case 'draw': case 'final': return true;
      case 'playing': return p.active && (this.runtime?.canMove(p) ?? false);
      default: return false;
    }
  }

  /** 서버 틱 한 번. 일시정지 중에는 시간이 멈춘다. */
  step() {
    if (this.paused) { this.flush(); return; }
    this.tick++;
    const sim = this.sim;
    sim.setTick(this.tick - this.levelTick);

    for (const p of this.players.values()) {
      if (!p.connected || !p.active || p.out) continue;
      // 입력 한 개 = 물리 한 걸음. 클라이언트 예측과 걸음 수가 정확히 맞아야 보정이 줄어든다.
      // 토큰 버킷으로 틱당 평균 1개(순간 최대 4개)만 허용해 입력을 몰아 보내는 속도 조작을 막는다.
      const can = this.canMove(p);
      p.tokens = Math.min(4, p.tokens + 1);
      let stepped = false;
      while (p.tokens >= 1 && p.queue.length > 0) {
        const m = p.queue.shift()!;
        p.tokens--;
        p.lastSeq = m[0] | 0;
        p.input.mx = Math.max(-127, Math.min(127, m[1] | 0)) / 127;
        p.input.mz = Math.max(-127, Math.min(127, m[2] | 0)) / 127;
        p.input.jump = (m[3] & 1) !== 0;
        p.input.action = (m[3] & 2) !== 0;
        sim.stepPlayer(p.state, p.input, p.id, can);
        stepped = true;
      }
      if (stepped) p.starve = 0;
      else if (++p.starve > 8) {
        // 입력이 0.3초 넘게 끊기면 조작 없이 물리만 진행한다(공중에 멈춰 있지 않게)
        p.input.mx = 0; p.input.mz = 0; p.input.jump = false; p.input.action = false;
        sim.stepPlayer(p.state, p.input, p.id, can);
      }
    }
    this.separatePlayers();

    if (this.phase === 'playing' && this.runtime) {
      this.runtime.onTick();
      if (this.runtime.isOver() || this.tick >= this.phaseEndTick) this.finishRound();
    } else if (this.phaseEndTick && this.tick >= this.phaseEndTick) {
      if (this.phase === 'draw') this.startCountdown();
      else if (this.phase === 'countdown') this.startPlaying();
      else if (this.phase === 'result') {
        if (this.round >= this.config.rounds) this.toFinal(); else this.startDraw();
      }
    }

    // 대기실에서 1분 넘게 끊긴 학생은 자리를 비운다
    if (this.phase === 'lobby' && this.tick % (TICK_RATE * 5) === 0) {
      const now = Date.now();
      for (const p of [...this.players.values()]) {
        if (!p.connected && now - p.leftAt > 60_000) { this.players.delete(p.id); this.dirty = true; }
      }
    }
    this.flush();
    // 게임별 상태는 바뀌었을 때만, 최대 초당 10번 보낸다
    if (this.gameDirty && this.tick % 3 === 0) {
      this.gameDirty = false;
      this.io.to(this.channel).emit('g', { key: this.levelKey, state: this.gameState });
    }
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();
  }

  /** 겹친 캐릭터를 서로 밀어낸다(서버 판정). 벽을 뚫지 않도록 물리 엔진을 거쳐 이동한다. */
  private separatePlayers() {
    const list: Player[] = [];
    for (const p of this.players.values()) if (p.connected && p.active && !p.out) list.push(p);
    const min = PLAYER_RADIUS * 2;
    for (let i = 0; i < list.length; i++) {
      const a = list[i].state;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j].state;
        const dx = b.x - a.x, dz = b.z - a.z;
        if (dx > min || dx < -min || dz > min || dz < -min || Math.abs(b.y - a.y) > 1) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2);
        // 완전히 겹치면 자리 번호로 방향을 정해 흩어 놓는다
        const nx = d > 1e-4 ? dx / d : Math.cos(i * 2.4), nz = d > 1e-4 ? dz / d : Math.sin(i * 2.4);
        const push = Math.min(0.12, (min - d) * 0.5);
        this.sim.nudge(a, -nx * push, -nz * push);
        this.sim.nudge(b, nx * push, nz * push);
      }
    }
  }

  private broadcastSnapshot() {
    const snap: SnapPlayer[] = [];
    for (const p of this.players.values()) {
      const s = p.state;
      let flags = 0;
      if (s.grounded) flags |= FLAG_GROUNDED;
      if (s.stun > 0) flags |= FLAG_STUN;
      if (p.done) flags |= FLAG_DONE;
      if (!p.connected || !p.active || p.out) flags |= FLAG_HIDDEN;
      if (Math.abs(s.vx) + Math.abs(s.vz) > 0.5) flags |= FLAG_MOVING;
      if (this.tick - p.pushAt < 9) flags |= FLAG_ACT;
      snap.push({ id: p.id, x: s.x, y: s.y, z: s.z, yaw: s.yaw, flags });
    }
    const buf = Buffer.from(encodeSnapshot(this.tick, snap));
    this.io.to(this.channel).emit('s', buf);
    let recipients = this.hosts.size;
    for (const p of this.players.values()) {
      if (!p.socket) continue;
      recipients++;
      const me: SelfMsg = { t: this.tick, q: p.lastSeq, s: packState(p.state) };
      p.socket.emit('me', me);
      metrics.bytesOut += 150;
    }
    metrics.bytesOut += (buf.length + 12) * recipients;
    metrics.snapshots++;
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.io.to(this.channel).emit('room', this.snapshotState());
  }

  snapshotState(): RoomState {
    return {
      code: this.code, config: this.config, phase: this.phase, paused: this.paused,
      round: this.round, gameId: this.gameId,
      levelId: this.levelId, levelSeed: this.levelSeed, levelKey: this.levelKey, levelTick: this.levelTick,
      phaseEndTick: this.phaseEndTick,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected, active: p.active, place: p.place, out: p.out,
      })),
      lastResult: this.lastResult,
      history: this.history,
    };
  }

  /** 교사 화면이 붙을 때 현재 틱을 알려 주기 위한 값 */
  markDirty() { this.dirty = true; }
  dispose() { this.sim.free(); }
}
