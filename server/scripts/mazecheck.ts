/**
 * 미로가 항상 풀리는지 확인: 시드 여러 개에 대해 격자 탐색으로 출발점→결승 경로를 찾는다.
 * (1) 문이 전부 닫힌 최악의 경우에도 길이 있는지 (2) 문이 열리면 더 짧아지는지
 *   npx tsx scripts/mazecheck.ts
 */
import { buildLevel, moverOffset, type Box } from '@shared';

const CELL = 0.25, R = 0.45; // 플레이어 반지름보다 조금 크게 잡아 좁은 틈은 막힌 것으로 본다
function solve(walls: Box[], finishZ: number): number {
  const X0 = -11, Z0 = 0, NX = Math.round(22 / CELL), NZ = Math.round((finishZ + 2) / CELL);
  const blocked = new Uint8Array(NX * NZ);
  for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
    const x = X0 + (i + 0.5) * CELL, z = Z0 + (j + 0.5) * CELL;
    for (const w of walls) if (Math.abs(x - w.p[0]) < w.h[0] + R && Math.abs(z - w.p[2]) < w.h[2] + R) { blocked[i + j * NX] = 1; break; }
  }
  const dist = new Int32Array(NX * NZ).fill(-1);
  const start = Math.round(11 / CELL) + Math.round(3 / CELL) * NX;
  const queue = [start]; dist[start] = 0;
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h], i = c % NX, j = Math.floor(c / NX);
    if (j * CELL >= finishZ) return dist[c] * CELL;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
      const n = ni + nj * NX;
      if (blocked[n] || dist[n] >= 0) continue;
      dist[n] = dist[c] + 1; queue.push(n);
    }
  }
  return -1;
}

let bad = 0;
for (let seed = 1; seed <= 300; seed++) {
  const l = buildLevel('maze', seed * 7919);
  const walls = l.statics.filter((b) => b.p[1] > 0);
  // 문이 틈을 정확히 막고 있는 순간(가장 불리한 경우)
  const closed = l.movers.map((m) => ({ p: m.p, h: m.h }));
  const worst = solve([...walls, ...closed], l.track!.z1);
  const best = solve(walls, l.track!.z1);
  // 문이 끝까지 열렸을 때 틈이 실제로 비는지
  const opened = l.movers.filter((m) => m.travel[1] === 0).map((m) => { const o = moverOffset(m, (0.25 - m.phase) * m.period); return { p: [m.p[0] + o[0], m.p[1], m.p[2]] as [number, number, number], h: m.h }; });
  const open = solve([...walls, ...opened], l.track!.z1);
  if (worst < 0 || best < 0 || open < 0 || open > best + 0.5) { bad++; console.log('문제 있는 시드', seed, { worst, best, open }); }
  if (seed <= 3) console.log(`시드 ${seed}: 문 전부 닫힘 ${worst.toFixed(0)}m / 문 열림 ${open.toFixed(0)}m`);
}
console.log(bad === 0 ? '300개 시드 모두 통과: 문이 전부 닫혀 있어도 길이 있다' : `실패 ${bad}개`);
