import { SNAP_POS_SCALE } from './constants';
import type { BankQ, ChemFilter, PublicQ } from './chem/bank';
import type { GameMode } from './games';

export type Phase = 'lobby' | 'draw' | 'countdown' | 'playing' | 'result' | 'final';

export interface PlayerInfo {
  id: number; // 방 안에서의 자리 번호(0~39)
  name: string;
  color: string;
  score: number;
  connected: boolean;
  /** 이번 라운드에 참가 중인지(게임 도중 들어오면 false = 관전) */
  active: boolean;
  /** 이번 라운드 순위가 확정된 경우(완주/탈락) */
  place: number | null;
  /** 이번 라운드에서 탈락해 관전 중 */
  out: boolean;
}

export interface RoundRow {
  id: number;
  name: string;
  color: string;
  rank: number;
  points: number;
  detail: string; // "완주 43.2초", "진행 62%" 등
  total: number;
}

export interface RoomConfig {
  mode: GameMode;
  rounds: number;
  games: string[]; // 추첨에 넣을 미니게임 id
  /** 화학 모드 출제 범위(단원, 난이도) */
  chem?: ChemFilter;
  /** 학생 기기에서 소리를 낼지(교사가 수업 중에 끌 수 있다). 기본 true */
  studentSound?: boolean;
}

export interface RoomState {
  code: string;
  config: RoomConfig;
  phase: Phase;
  paused: boolean;
  round: number; // 1부터
  gameId: string | null;
  /** 지금 불러와야 할 맵. levelKey가 바뀌면 클라이언트가 맵을 새로 만든다. */
  levelId: string;
  levelSeed: number;
  levelKey: string;
  /** 화학 모드에서 이번 맵에 쓰는 문제(정답 제외) */
  levelQuiz: PublicQ[] | null;
  /** 방의 문제은행에 든 문제 수 */
  bankSize: number;
  /** 맵 시간의 기준 틱(움직이는 장애물 위상 = tick - levelTick) */
  levelTick: number;
  /** 현재 단계가 끝나는 서버 틱(없으면 0) */
  phaseEndTick: number;
  players: PlayerInfo[];
  lastResult: RoundRow[] | null;
  history: { round: number; gameId: string; rows: RoundRow[] }[];
}

export interface JoinReq { code: string; name: string; color: string; token?: string }
export type JoinRes =
  | { ok: true; id: number; token: string; name: string; tickRate: number }
  | { ok: false; error: string };

export interface CreateReq { config: RoomConfig }
export interface CreateRes { ok: boolean; code?: string; hostToken?: string; error?: string }

export type HostCmd =
  | { type: 'start' } | { type: 'pause' } | { type: 'resume' } | { type: 'skip' }
  | { type: 'end' } | { type: 'toLobby' } | { type: 'kick'; id: number }
  | { type: 'config'; config: RoomConfig }
  | { type: 'bank'; bank: BankQ[] }
  | { type: 'sound'; on: boolean }
  | { type: 'close' };

/** 클라이언트 → 서버 입력: [seq, mx(-127~127), mz, 버튼비트] */
export type InputMsg = [number, number, number, number];

/** 자기 캐릭터의 정확한 상태(예측 보정용): t=서버 틱, q=마지막으로 처리한 입력 번호 */
export interface SelfMsg { t: number; q: number; s: number[] }

/**
 * 내 정확한 상태(바이너리): 틱 u32, 처리한 입력 번호 u32, 상태값 Float32 × n.
 * 위치 스냅샷과 함께 한 메시지('u')로 보내서 학생 한 명이 받는 패킷 수를 줄인다(무선망 혼잡 완화).
 */
export function encodeSelf(m: SelfMsg): Uint8Array {
  const buf = new ArrayBuffer(8 + m.s.length * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, m.t); dv.setUint32(4, m.q >>> 0);
  for (let i = 0; i < m.s.length; i++) dv.setFloat32(8 + i * 4, m.s[i]);
  return new Uint8Array(buf);
}
export function decodeSelf(buf: ArrayBuffer): SelfMsg {
  const dv = new DataView(buf);
  const n = (buf.byteLength - 8) / 4, s: number[] = new Array(n);
  for (let i = 0; i < n; i++) s[i] = dv.getFloat32(8 + i * 4);
  return { t: dv.getUint32(0), q: dv.getUint32(4), s };
}
/** base64 → ArrayBuffer (브라우저와 Node 모두에서 동작) */
export function fromB64(b64: string): ArrayBuffer {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ---- 스냅샷(바이너리): 틱(u32) 인원(u8) + 인원 × [id u8, x y z i16, yaw u8, flags u8] ----
export const FLAG_GROUNDED = 1;
export const FLAG_STUN = 2;
export const FLAG_DONE = 4; // 완주/탈락
export const FLAG_HIDDEN = 8; // 관전 중(그리지 않음)
export const FLAG_SHOVED = 16; // 방금 밀쳐져서 비틀거리는 중
export const FLAG_ACT = 32; // 방금 밀치기를 썼다(동작 표시용)
export const FLAG_GRAB = 64; // 누군가를 잡고 있다
export const FLAG_HELD = 128; // 누군가에게 잡혀 있다
const REC = 9;

export interface SnapPlayer { id: number; x: number; y: number; z: number; yaw: number; flags: number }

export function encodeSnapshot(tick: number, players: SnapPlayer[]): ArrayBuffer {
  const buf = new ArrayBuffer(5 + players.length * REC);
  const dv = new DataView(buf);
  dv.setUint32(0, tick);
  dv.setUint8(4, players.length);
  let o = 5;
  const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * SNAP_POS_SCALE)));
  for (const p of players) {
    dv.setUint8(o, p.id);
    dv.setInt16(o + 1, q(p.x)); dv.setInt16(o + 3, q(p.y)); dv.setInt16(o + 5, q(p.z));
    dv.setUint8(o + 7, Math.round((((p.yaw % 6.2832) + 6.2832) % 6.2832) * (256 / 6.2832)) & 255);
    dv.setUint8(o + 8, p.flags);
    o += REC;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): { tick: number; players: SnapPlayer[] } {
  const dv = new DataView(buf);
  const tick = dv.getUint32(0);
  const n = dv.getUint8(4);
  const players: SnapPlayer[] = [];
  let o = 5;
  for (let i = 0; i < n; i++) {
    players.push({
      id: dv.getUint8(o),
      x: dv.getInt16(o + 1) / SNAP_POS_SCALE, y: dv.getInt16(o + 3) / SNAP_POS_SCALE, z: dv.getInt16(o + 5) / SNAP_POS_SCALE,
      yaw: (dv.getUint8(o + 7) * 6.2832) / 256,
      flags: dv.getUint8(o + 8),
    });
    o += REC;
  }
  return { tick, players };
}

/** 미니게임별 실시간 상태(서버 → 전원). 게임마다 필요한 칸만 채운다. */
export interface CollectState {
  /** 이미 누가 가져간 보물 번호 */
  taken?: number[];
  /** [플레이어 번호, 점수] */
  scores?: [number, number][];
  /** 꼬리를 가진 플레이어 번호 */
  tails?: number[];
  /** 가장 최근에 채점한 문제 번호와 맞힌 사람 */
  quiz?: { index: number; correct: number[]; answer?: number; explain?: string };
}
export interface GameStateMsg { key: string; state: CollectState | null }

/** 한 학생에게만 보내는 알림(화학 미로): 통과한 문제와 해설, 또는 틀린 문 */
export interface PersonalMsg { key: string; pass?: { q: number; explain: string; first: boolean }; wrong?: [number, number] }
