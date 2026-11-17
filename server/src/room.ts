import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Server, Socket } from 'socket.io';
import {
  COUNTDOWN_SEC, DT, FLAG_ACT, FLAG_DONE, FLAG_GRAB, FLAG_HELD, FLAG_GROUNDED, FLAG_HIDDEN, FLAG_SHOVED, FLAG_STUN, MAX_PLAYERS, NO_INPUT, PLAYER_COLORS, PLAYER_RADIUS,
  ALL_UNITS, BODY_DIST, DEFAULT_BANK, PODIUM, PODIUM_Z, SNAPSHOT_EVERY, SimWorld, TICK_RATE, bodyPush, buildLevel, cleanBank, pickQuestions, encodeSnapshot, getGame, newPlayerState, packState,
  type HostCmd, type InputMsg, type JoinReq, type JoinRes, type LevelDef, type Phase, type PlayerInput,
  encodeSelf, type BankQ, type PickedQ, type PlayerState, type QLevel, type RoomConfig, type RoomState, type RoundRow, type SnapPlayer,
} from '@shared';
import { drawGame, getMinigame, playableIds } from './minigames';
import type { GameCtx, GamePlayer, MinigameRuntime } from './minigames/types';
import { metrics } from './metrics';

const sec = (s: number) => Math.round(s * TICK_RATE);
const DRAW_TICKS = sec(6);
const COUNTDOWN_TICKS = sec(COUNTDOWN_SEC);
const RESULT_TICKS = sec(12);
const GRAB_MAX = Math.round(2.5 * TICK_RATE);
const GRAB_COOLDOWN = Math.round(1.5 * TICK_RATE);
// 무선 네트워크는 0.2~0.5초씩 멈췄다가 밀린 입력을 한꺼번에 보내는 일이 흔하다.
// 그 묶음을 버리거나 쌓아 두면 화면이 되돌아가거나 계속 굼떠지므로, 0.75초치까지는 받아서 바로 따라잡는다.
const MAX_QUEUE = Math.round(0.75 * TICK_RATE);
const STARVE_TICKS = Math.round(0.75 * TICK_RATE); // 이만큼 입력이 없으면 그제서야 조작 없이 물리만 진행한다
const MAX_TOKENS = Math.round(0.75 * TICK_RATE); // 멈춰 있던 동안 못 쓴 걸음 수(이만큼은 한꺼번에 따라잡을 수 있다)
const LATE_MAX = Math.round(0.3 * TICK_RATE);
const CUSHION = 2; // 입력이 이보다 많이 밀려 있으면 따라잡기 시작한다
const GUESS_TICKS = Math.round(0.1 * TICK_RATE); // 늦는 입력을 직전 입력으로 어림해 주는 최대 시간(0.1초)

class Player implements GamePlayer {
  socket: Socket | null = null;
  score = 0;
  state: PlayerState;
  queue: InputMsg[] = [];
  input: PlayerInput = { ...NO_INPUT };
  lastSeq = 0;
  starve = 0; // 입력이 안 온 연속 틱
  tokens = 2;
  resyncUntil = 0;
  guessed = 0; // 어림해서 미리 처리한 걸음 수
  active = true;
  done = false;
  out = false;
  pushAt = -999;
  /** 잡기: 지금 잡고 있는 상대, 잡기 시작한 틱, 다시 잡을 수 있는 틱 */
  grabbing: Player | null = null;
  grabStart = 0;
  grabReady = 0;
  held = false;
  jumpWas = false;
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
  private urgent = true;
  private lastFlush = -999;
  /** 교사가 편집한 문제은행(없으면 기본 문제) */
  private bank: BankQ[] = DEFAULT_BANK;
  /** 이번 맵에 출제한 문제(정답 포함). 클라이언트에는 정답을 빼고 보낸다. */
  private levelQuiz: PickedQ[] | null = null;
  private askedIds = new Set<string>();
  private gameDirty = false;
  lastActive = Date.now();
  /** 연속으로 틱 오류가 난 횟수 */
  faults = 0;

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
    this.config.studentSound = this.config.studentSound !== false;
    const c = this.config.chem;
    const units = (c?.units ?? []).filter((u) => ALL_UNITS.includes(u));
    const levels = (c?.levels ?? []).filter((l): l is QLevel => l === 'easy' || l === 'normal' || l === 'hard');
    this.config.chem = { units: units.length ? units : [3, 4], levels: levels.length ? levels : ['easy', 'normal', 'hard'] };
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
    p.guessed = 0;
    p.queue.length = 0;
    p.input = { ...NO_INPUT };
    p.starve = 0;
    socket.data.playerId = p.id;
    socket.data.code = this.code;
    socket.join(this.channel);
    this.dirty = true;
    this.lastActive = Date.now();
    socket.emit('room', this.snapshotState(false));
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

  /** 입력 받기. 클라이언트는 입력 여러 개를 한 메시지에 이어 붙여 보낸다: [seq, mx, mz, 버튼, seq, mx, mz, 버튼, ...] */
  onInput(id: number, msg: number[]) {
    const p = this.players.get(id);
    if (!p || !Array.isArray(msg) || msg.length < 4 || msg.length > 4 * 64) return;
    // 0.75초 넘게 끊겼다 돌아온 경우: 서버는 이미 그 시간만큼 물리를 진행했으므로 밀린 옛 입력은 버리고
    // 가장 최근 것만 받는다(안 그러면 계속 과거 입력을 처리하느라 조작이 굼떠진다).
    if (p.starve > STARVE_TICKS) p.resyncUntil = this.tick + Math.round(0.25 * TICK_RATE);
    const cap = this.tick < p.resyncUntil ? 4 : MAX_QUEUE;
    for (let i = 0; i + 3 < msg.length; i += 4) {
      while (p.queue.length >= cap) p.queue.shift(); // 넘치면 오래된 것부터 버린다
      p.queue.push([msg[i], msg[i + 1], msg[i + 2], msg[i + 3]]);
    }
  }

  setColor(id: number, color: string) {
    const p = this.players.get(id);
    if (p && (PLAYER_COLORS as readonly string[]).includes(color)) { p.color = color; this.dirty = true; }
  }

  // ---------- 교사 명령 ----------

  hostCmd(cmd: HostCmd) {
    this.lastActive = Date.now();
    this.urgent = true;
    switch (cmd.type) {
      case 'sound':
        this.config.studentSound = !!cmd.on;
        break;
      case 'bank': {
        // 문제은행 교체: 쓸 수 있는 문제가 하나도 없으면 기본 문제를 유지한다
        const b = cleanBank(cmd.bank);
        this.bank = b.length ? b : DEFAULT_BANK;
        break;
      }
      case 'config':
        if (this.phase === 'lobby') { this.config = cmd.config; this.sanitizeConfig(); }
        break;
      case 'start':
        if (this.phase === 'lobby' && this.players.size > 0) {
          this.round = 0; this.history = []; this.drawn = []; this.lastResult = null;
          this.askedIds.clear();
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
    this.urgent = true;
    this.phase = phase;
    this.phaseEndTick = duration > 0 ? this.tick + duration : 0;
    this.dirty = true;
  }

  private setLevel(levelId: string, seed: number, quiz: PickedQ[] | null = null) {
    this.sim.free();
    this.levelQuiz = quiz;
    this.level = buildLevel(levelId, seed, quiz);
    this.sim = new SimWorld(this.R, this.level);
    this.levelId = levelId;
    this.levelSeed = seed;
    this.levelKey = `${levelId}:${++this.levelSerial}`;
    this.urgent = true;
    this.levelTick = this.tick;
    this.gameState = null;
    this.gameDirty = false;
    for (const p of this.players.values()) {
      p.state = newPlayerState(this.level, p.id);
      p.grabbing = null;
      p.queue.length = 0;
      p.input = { ...NO_INPUT };
    }
    this.dirty = true;
  }

  private startDraw() {
    this.round++;
    this.gameId = drawGame(this.config.games, this.drawn, this.config.mode);
    this.drawn.push(this.gameId);
    if (this.levelId !== 'lobby') this.setLevel('lobby', 0);
    for (const p of this.players.values()) { p.done = false; p.out = false; p.place = null; p.active = true; }
    this.setPhase('draw', DRAW_TICKS);
  }

  private startCountdown() {
    const seed = (Math.random() * 2 ** 31) | 0;
    // 화학 모드의 학습형 게임이면 문제은행에서 이번 판 문제를 뽑는다(같은 경기에서 나온 문제는 뒤로 미룬다)
    const meta = getGame(this.gameId!)!;
    let quiz: PickedQ[] | null = null;
    if (this.config.mode === 'chem' && meta.chem) {
      const picked = pickQuestions(this.bank, this.config.chem!, meta.chem.questions, Math.random, meta.chem.options, this.askedIds);
      for (const q of picked) this.askedIds.add(q.id);
      quiz = picked;
    }
    this.setLevel(this.gameId!, seed, quiz);
    this.roundPlayers = [...this.players.values()];
    for (const p of this.roundPlayers) { p.active = true; p.done = false; p.out = false; p.place = null; }
    this.setPhase('countdown', COUNTDOWN_TICKS);
  }

  private startPlaying() {
    const meta = getGame(this.gameId!)!;
    this.gameStartTick = this.tick;
    this.setPhase('playing', sec(this.level.duration ?? meta.timeLimit));
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
      seed: this.levelSeed,
      tell: (id, msg) => { this.players.get(id)?.socket?.emit('gp', { key: this.levelKey, ...msg }); },
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
    // 1~3위를 시상대 위에, 나머지는 시상대를 바라보게 세운다
    const top = [...this.players.values()].sort((a, b) => b.score - a.score).slice(0, 3);
    for (const p of this.players.values()) p.state.yaw = 0;
    top.forEach((p, i) => {
      p.state.x = PODIUM[i].x; p.state.z = PODIUM_Z; p.state.y = PODIUM[i].h * 2 + 0.05;
      p.state.yaw = Math.PI; // 친구들 쪽을 본다
    });
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
      // 걸음 수는 토큰으로 센다: 틱마다 1개씩 쌓이고 입력 하나에 1개를 쓴다. 긴 시간으로 보면 틱당 1걸음을
      // 넘을 수 없어 속도 조작이 안 되고, 네트워크가 잠깐 멈췄다 몰려온 입력은 쌓인 토큰으로 바로 따라잡는다.
      const can = this.canMove(p);
      const slow = p.grabbing !== null || p.held;
      p.tokens = Math.min(MAX_TOKENS, p.tokens + 1);
      // 이미 어림해서 처리한 번호의 입력(아래 참고)은 버린다
      let dropped = 0;
      while (p.queue.length > 0 && (p.queue[0][0] | 0) <= p.lastSeq && p.guessed > 0) { p.queue.shift(); p.guessed--; dropped++; metrics.dropped++; }
      // 따라잡을 토큰이 없는데도 입력이 0.3초치 넘게 밀려 있다면, 이 기기는 서버보다 빠르게 입력을 보내고 있는 것이다
      // (시계 차이나 속도 조작). 계속 쌓이면 조작이 점점 늦게 먹으므로 오래된 것을 버리고 최근 0.1초치만 남긴다.
      if (p.tokens < 2 && p.queue.length > LATE_MAX) { metrics.dropped += p.queue.length - GUESS_TICKS; p.queue.splice(0, p.queue.length - GUESS_TICKS); }
      // 평소에는 틱당 1걸음. 밀린 입력이 쌓여 있으면 2걸음씩 처리해 부드럽게 따라잡는다
      // (한꺼번에 처리하면 다른 사람 화면에서 순간이동처럼 보인다).
      let budget = p.queue.length > CUSHION ? 2 : 1;
      let steps = 0;
      while (budget-- > 0 && p.tokens >= 1 && p.queue.length > 0) {
        const m = p.queue.shift()!;
        p.tokens--;
        p.lastSeq = m[0] | 0;
        p.guessed = 0;
        p.input.mx = Math.max(-127, Math.min(127, m[1] | 0)) / 127;
        p.input.mz = Math.max(-127, Math.min(127, m[2] | 0)) / 127;
        p.input.jump = (m[3] & 1) !== 0;
        p.input.action = (m[3] & 2) !== 0;
        p.input.grab = (m[3] & 4) !== 0;
        sim.stepPlayer(p.state, p.input, p.id, can, slow);
        steps++;
        metrics.inputs++;
      }
      if (steps > 0) p.starve = 0;
      else if (dropped > 0) {
        // 미리 처리해 둔 걸음의 진짜 입력이 이제 도착했다: 그만큼은 이미 움직였으므로 이번 틱은 쉰다.
        // (여기서 또 어림하면 진짜 입력을 영영 따라잡지 못한다)
        p.starve = 0;
      } else if (p.tokens >= 1 && p.lastSeq > 0 && p.guessed < GUESS_TICKS && p.starve <= GUESS_TICKS) {
        // 입력이 조금 늦는 중(흔한 흔들림): 직전 입력이 이어진다고 보고 한 걸음 미리 처리한다.
        // 그 번호의 진짜 입력이 나중에 오면 버린다. 덕분에 다른 사람 화면에서 캐릭터가 멈칫거리지 않는다.
        p.tokens--; p.lastSeq++; p.guessed++; p.starve++;
        metrics.guessed++;
        sim.stepPlayer(p.state, p.input, p.id, can, slow);
      } else if ((metrics.idle++, ++p.starve) > STARVE_TICKS) {
        // 입력이 0.75초 넘게 끊겼다: 조작 없이 물리만 진행한다. 쌓인 토큰은 버려서 나중에 두 번 움직이지 않게 한다.
        p.tokens = 0; p.guessed = 0;
        p.input.mx = 0; p.input.mz = 0; p.input.jump = false; p.input.action = false; p.input.grab = false;
        sim.stepPlayer(p.state, p.input, p.id, can, slow);
      }
    }
    this.updateGrabs();
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
    if (this.gameDirty && this.tick % Math.round(TICK_RATE / 10) === 0) {
      this.gameDirty = false;
      this.io.to(this.channel).emit('g', { key: this.levelKey, state: this.gameState });
    }
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();
  }

  /**
   * 잡기: 버튼을 누르고 있는 동안 앞에 있는 가까운 상대를 붙잡아 끌어당긴다(서버 판정).
   * 최대 2.5초까지 잡을 수 있고, 놓으면 1.5초 뒤에 다시 잡을 수 있다. 잡힌 쪽은 점프를 누르면 뿌리친다.
   */
  private updateGrabs() {
    const MAX = GRAB_MAX, tick = this.tick;
    for (const p of this.players.values()) p.held = false;
    for (const p of this.players.values()) {
      const ok = p.connected && p.active && !p.out && p.state.stun === 0 && this.canMove(p);
      let t = p.grabbing;
      if (t) {
        const d = Math.hypot(t.state.x - p.state.x, t.state.z - p.state.z);
        const broke = t.input.jump && !t.jumpWas; // 잡힌 쪽이 점프로 뿌리쳤다
        if (!ok || !p.input.grab || broke || !t.connected || t.out || !t.active || this.players.get(t.id) !== t
          || d > 2.4 || Math.abs(t.state.y - p.state.y) > 1.6 || tick - p.grabStart > MAX) {
          p.grabbing = t = null;
          p.grabReady = tick + GRAB_COOLDOWN;
        }
      }
      if (!t && ok && p.input.grab && tick >= p.grabReady) {
        // 앞쪽 부채꼴 안에서 가장 가까운 상대를 잡는다
        const fx = Math.sin(p.state.yaw), fz = Math.cos(p.state.yaw);
        let best: Player | null = null, bestD = 1.45;
        for (const q of this.players.values()) {
          if (q === p || !q.connected || !q.active || q.out) continue;
          const dx = q.state.x - p.state.x, dz = q.state.z - p.state.z, d = Math.hypot(dx, dz);
          if (d >= bestD || Math.abs(q.state.y - p.state.y) > 1.1) continue;
          if (d > 0.3 && (dx * fx + dz * fz) / d < 0.2) continue;
          bestD = d; best = q;
        }
        if (best) { p.grabbing = t = best; p.grabStart = tick; }
      }
      if (t) {
        t.held = true;
        const dx = t.state.x - p.state.x, dz = t.state.z - p.state.z, d = Math.hypot(dx, dz) || 0.001;
        if (d > 1.05) {
          // 팽팽한 끈처럼 거리를 유지한다: 잡은 쪽은 느려지고 잡힌 쪽은 끌려온다(도망쳐서 풀 수 없다)
          const over = d - 1.05;
          this.sim.nudge(t.state, (-dx / d) * over * 0.55, (-dz / d) * over * 0.55);
          this.sim.nudge(p.state, (dx / d) * over * 0.45, (dz / d) * over * 0.45);
        }
      }
    }
    for (const p of this.players.values()) p.jumpWas = p.input.jump;
  }

  /** 방을 닫는다: 모두 첫 화면으로 돌려보낸다. */
  close() {
    this.io.to(this.channel).emit('closed');
    for (const p of this.players.values()) {
      if (p.socket) { p.socket.leave(this.channel); p.socket.data.playerId = undefined; p.socket.data.code = undefined; }
    }
    this.players.clear();
    this.dispose();
  }

  /** 겹친 캐릭터를 서로 밀어낸다(서버 판정). 벽을 뚫지 않도록 물리 엔진을 거쳐 이동한다. */
  private separatePlayers() {
    const list: Player[] = [];
    for (const p of this.players.values()) if (p.connected && p.active && !p.out) list.push(p);
    const min = BODY_DIST;
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
        const push = bodyPush(d);
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
      if (s.shove > 0) flags |= FLAG_SHOVED;
      if (this.tick - p.pushAt < TICK_RATE * 0.3) flags |= FLAG_ACT;
      if (p.grabbing) flags |= FLAG_GRAB;
      if (p.held) flags |= FLAG_HELD;
      snap.push({ id: p.id, x: s.x, y: s.y, z: s.z, yaw: s.yaw, flags });
    }
    // 학생마다 [모두의 위치, 내 정확한 상태]를 문자열 하나로 묶어 보낸다.
    // 바이너리를 따로 보내면 socket.io가 조각 두 개로 나눠 보내므로, base64 문자열로 바꿔 한 조각에 담는다.
    const snapB64 = Buffer.from(encodeSnapshot(this.tick, snap)).toString('base64');
    let bytes = 0;
    for (const p of this.players.values()) {
      if (!p.socket) continue;
      const selfB64 = Buffer.from(encodeSelf({ t: this.tick, q: p.lastSeq, s: packState(p.state) })).toString('base64');
      p.socket.emit('u', snapB64, selfB64);
      bytes += snapB64.length + selfB64.length + 12;
    }
    if (this.hosts.size) this.io.to(this.hostChannel).emit('u', snapB64);
    metrics.bytesOut += bytes + (snapB64.length + 10) * this.hosts.size;
    metrics.snapshots++;
  }

  /**
   * 방 상태 보내기. 학생 40명에게 4~5KB씩 가는 메시지라, 급하지 않은 변화(순위·탈락 표시)는 0.25초씩 모아서 보낸다.
   * 단계 전환·맵 변경·교사 명령은 바로 보낸다. 경기 기록(history)은 교사 화면에만 보낸다.
   */
  private flush() {
    if (!this.dirty) return;
    if (!this.urgent && this.tick - this.lastFlush < Math.round(TICK_RATE / 4)) return;
    this.dirty = false;
    this.urgent = false;
    this.lastFlush = this.tick;
    this.io.to(this.channel).except(this.hostChannel).emit('room', this.snapshotState(false));
    if (this.hosts.size) this.io.to(this.hostChannel).emit('room', this.snapshotState(true));
  }

  get hostChannel() { return `h:${this.code}`; }

  /** forHost=false면 학생용: 경기 기록을 빼고, 라운드 결과는 결과 화면일 때만 넣는다 */
  snapshotState(forHost = true): RoomState {
    return {
      code: this.code, config: this.config, phase: this.phase, paused: this.paused,
      round: this.round, gameId: this.gameId,
      levelId: this.levelId, levelSeed: this.levelSeed, levelKey: this.levelKey, levelTick: this.levelTick,
      phaseEndTick: this.phaseEndTick,
      levelQuiz: this.levelQuiz?.map((q) => ({ text: q.text, options: q.options, unit: q.unit, level: q.level })) ?? null,
      bankSize: this.bank.length,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected, active: p.active, place: p.place, out: p.out,
      })),
      lastResult: forHost || this.phase === 'result' ? this.lastResult : null,
      history: forHost ? this.history : [],
    };
  }

  /** 경기 중 오류가 반복되면 점수는 그대로 두고 대기실로 돌려보낸다. */
  recover() {
    this.runtime = null;
    this.faults = 0;
    this.paused = false;
    this.setLevel('lobby', 0);
    this.setPhase('lobby', 0);
    this.gameId = null;
    for (const p of this.players.values()) { p.active = true; p.done = false; p.out = false; p.place = null; }
    this.io.to(this.channel).emit('notice', '게임에 문제가 생겨 대기실로 돌아왔어요. 점수는 그대로예요.');
  }

  /** 교사 화면이 붙을 때 현재 틱을 알려 주기 위한 값 */
  markDirty() { this.dirty = true; }
  dispose() { this.sim.free(); }
}
