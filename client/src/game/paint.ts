import { PAINT_BLOCK, paintCell } from '@shared';
import { net } from './net';
import { useStore } from './store';

/**
 * 색깔 땅따먹기 판의 학생 화면 사본.
 * 서버 판(초당 5번)에 더해, 내가 밟은 칸은 서버 확인을 기다리지 않고 바로 우리 팀 색으로 보여 준다.
 * 예측한 칸은 1.5초 안에 서버 판에 반영되지 않으면 서버 쪽 색으로 돌아간다(밀려서 못 밟은 경우 등).
 */
const pending = new Map<number, { team: string; until: number }>();
let src: string | null = null;
let view: string[] = [];
let version = 0;

function rebuild(server: string) {
  view = server.split('');
  const now = performance.now();
  for (const [c, p] of pending) {
    if (now > p.until || view[c] === p.team) pending.delete(c);
    else view[c] = p.team;
  }
  version++;
}

/** 프레임마다 부른다. 판이 바뀌었으면 version이 올라간다. */
export function updatePaint(): { cells: string[]; version: number } | null {
  const game = useStore.getState().game;
  const server = game?.paint;
  if (!server) { src = null; pending.clear(); return null; }
  let dirty = server !== src;
  if (dirty) src = server;
  // 내 칸 예측
  const st = net.myState();
  const { room, myId } = useStore.getState();
  const team = room?.players.find((p) => p.id === myId)?.team ?? -1;
  if (st && team >= 0 && room?.phase === 'playing' && st.grounded && st.y < 0.3) {
    const c = paintCell(st.x, st.z);
    const ch = String(team);
    if (c >= 0 && server[c] !== PAINT_BLOCK && server[c] !== ch && view[c] !== ch) {
      pending.set(c, { team: ch, until: performance.now() + 1500 });
      dirty = true;
    }
  }
  if (!dirty && pending.size) {
    const now = performance.now();
    for (const p of pending.values()) if (now > p.until) { dirty = true; break; }
  }
  if (dirty) rebuild(server);
  return { cells: view, version };
}
