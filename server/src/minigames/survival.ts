import { TICK_RATE, rankPoints } from '@shared';
import { createPusher } from './push';
import type { GameCtx, MinigameRuntime, MinigameServer, RoundOutcome } from './types';

const GRACE = 5 * TICK_RATE; // 연결이 끊긴 채 이만큼 지나면 탈락으로 본다

/**
 * 생존형 미니게임 공통 규칙: 떨어지면 탈락, 오래 버틸수록 높은 순위.
 * 무엇이 플레이어를 떨어뜨리는지(사라지는 발판, 회전봉 등)는 맵 데이터가 정한다.
 */
export function survivalGame(id: string, opts: { push?: boolean } = {}): MinigameServer {
  return {
    id,
    create(ctx: GameCtx): MinigameRuntime {
      const outTick = new Map<number, number>();
      const offline = new Map<number, number>();
      const started = ctx.players.length;
      const push = opts.push ? createPusher(ctx, (p) => !p.out) : null;

      const eliminate = (id: number) => {
        const p = ctx.players.find((x) => x.id === id);
        if (!p || p.out) return;
        p.out = true;
        p.done = true;
        outTick.set(id, ctx.elapsed());
        // 지금 탈락하면 남은 인원 바로 다음 순위
        p.place = ctx.players.filter((x) => !x.out).length + 1;
        ctx.touch();
      };

      return {
        onTick() {
          push?.();
          for (const p of ctx.players) {
            if (p.out) continue;
            if (p.state.falls > 0) { eliminate(p.id); continue; }
            if (!p.connected) {
              const n = (offline.get(p.id) ?? 0) + 1;
              offline.set(p.id, n);
              if (n > GRACE) eliminate(p.id);
            } else offline.delete(p.id);
          }
        },
        canMove: (p) => !p.out,
        isOver() {
          const alive = ctx.players.filter((p) => !p.out).length;
          // 여럿이 시작했으면 한 명 남을 때, 혼자면 떨어질 때 끝난다
          return started > 1 ? alive <= 1 : alive === 0;
        },
        outcome(): RoundOutcome[] {
          const out: RoundOutcome[] = [];
          const alive = ctx.players.filter((p) => !p.out);
          for (const p of alive) out.push({ id: p.id, rank: 1, points: rankPoints(1), detail: '끝까지 생존' });
          const gone = ctx.players.filter((p) => p.out).sort((a, b) => outTick.get(b.id)! - outTick.get(a.id)!);
          let rank = alive.length, prev = -1;
          gone.forEach((p, i) => {
            const t = outTick.get(p.id)!;
            if (t !== prev) { rank = alive.length + i + 1; prev = t; } // 같은 순간에 떨어지면 공동 순위
            out.push({ id: p.id, rank, points: rankPoints(rank), detail: `${(t / TICK_RATE).toFixed(1)}초 생존` });
          });
          return out;
        },
      };
    },
  };
}
