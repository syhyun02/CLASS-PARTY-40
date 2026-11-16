import { PLAYER_CENTER_Y, rankPoints, type CollectState } from '@shared';
import type { GameCtx, MinigameRuntime, MinigameServer, RoundOutcome } from './types';

const REACH = 0.95; // 보물을 집는 거리
const FALL_PENALTY = 3;

/**
 * 수집형 미니게임: 맵에 일정대로 나타나는 보물을 먼저 닿은 사람이 가져간다.
 * 같은 틱에 둘이 닿으면 더 가까운 사람이 갖는다. 떨어지면 점수가 깎인다.
 */
export function collectGame(id: string): MinigameServer {
  return {
    id,
    create(ctx: GameCtx): MinigameRuntime {
      const items = ctx.level.items ?? [];
      const taken = new Set<number>();
      const score = new Map<number, number>();
      const falls = new Map<number, number>();
      let next = 0; // 아직 나타나지 않은 첫 보물
      const live: number[] = [];
      const publish = () => {
        const st: CollectState = { taken: [...taken], scores: [...score.entries()] };
        ctx.publish(st);
      };

      return {
        onTick() {
          const t = ctx.levelTime();
          while (next < items.length && items[next].at <= t) live.push(next++);
          let changed = false;
          for (const p of ctx.players) {
            if (!p.connected) continue;
            const f = falls.get(p.id) ?? 0;
            if (p.state.falls > f) {
              falls.set(p.id, p.state.falls);
              score.set(p.id, Math.max(0, (score.get(p.id) ?? 0) - FALL_PENALTY));
              changed = true;
            }
          }
          for (let k = live.length - 1; k >= 0; k--) {
            const it = items[live[k]];
            let best = -1, bestD = REACH;
            for (const p of ctx.players) {
              if (!p.connected) continue;
              const s = p.state;
              if (Math.abs(s.y + PLAYER_CENTER_Y - it.p[1]) > 1.3) continue;
              const d = Math.hypot(s.x - it.p[0], s.z - it.p[2]);
              if (d < bestD) { bestD = d; best = p.id; }
            }
            if (best >= 0) {
              taken.add(live[k]);
              score.set(best, (score.get(best) ?? 0) + it.value);
              live.splice(k, 1);
              changed = true;
            }
          }
          if (changed) publish();
        },
        canMove: () => true,
        isOver: () => false, // 제한 시간까지 진행
        outcome(): RoundOutcome[] {
          const sorted = [...ctx.players].sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0));
          let rank = 0, prev = -1;
          return sorted.map((p, i) => {
            const v = score.get(p.id) ?? 0;
            if (v !== prev) { rank = i + 1; prev = v; }
            return { id: p.id, rank, points: v > 0 ? rankPoints(rank) : 5, detail: `보물 ${v}점` };
          });
        },
      };
    },
  };
}
