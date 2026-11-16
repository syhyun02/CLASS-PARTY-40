import { TICK_RATE, rankPoints } from '@shared';
import type { GameCtx, GamePlayer, MinigameRuntime, MinigameServer, RoundOutcome } from './types';

/** 장애물 레이스: 결승 구역에 먼저 들어온 순서로 순위를 매긴다. */
export const raceGame = (id: string): MinigameServer => ({
  id,
  create(ctx: GameCtx): MinigameRuntime {
    const finishCp = ctx.level.checkpoints.length - 1;
    const finishTick = new Map<number, number>();
    let shortened = false;

    const progress = (p: GamePlayer) => {
      const t = ctx.level.track!;
      return Math.max(0, Math.min(1, (p.state.z - t.z0) / (t.z1 - t.z0)));
    };

    return {
      onTick() {
        for (const p of ctx.players) {
          if (p.done) continue;
          // 결승 구역은 마지막 체크포인트라서 SimWorld가 cp를 올려 준다(서버 판정)
          if (p.state.cp >= finishCp) {
            p.done = true;
            finishTick.set(p.id, ctx.elapsed());
            p.place = finishTick.size;
            ctx.touch();
          }
        }
        // 절반이 들어오면 남은 시간을 20초로 줄여 늘어지지 않게 한다
        if (!shortened && finishTick.size >= Math.ceil(ctx.players.length / 2) && finishTick.size > 0) {
          shortened = true;
          if (ctx.ticksLeft() > 20 * TICK_RATE) ctx.shortenTo(20 * TICK_RATE);
        }
      },
      canMove: () => true, // 완주한 뒤에도 결승선 근처에서 뛰어놀 수 있다
      isOver() {
        const racing = ctx.players.filter((p) => !p.done && p.connected);
        return ctx.players.length > 0 && racing.length === 0;
      },
      outcome(): RoundOutcome[] {
        const out: RoundOutcome[] = [];
        const fin = ctx.players.filter((p) => finishTick.has(p.id)).sort((a, b) => finishTick.get(a.id)! - finishTick.get(b.id)!);
        let rank = 0, prev = -1;
        fin.forEach((p, i) => {
          const t = finishTick.get(p.id)!;
          if (t !== prev) { rank = i + 1; prev = t; } // 같은 틱에 들어오면 공동 순위
          out.push({ id: p.id, rank, points: rankPoints(rank), detail: `완주 ${(t / TICK_RATE).toFixed(1)}초` });
        });
        const cap = fin.length ? rankPoints(rank) - 2 : 50;
        const rest = ctx.players.filter((p) => !finishTick.has(p.id)).sort((a, b) => progress(b) - progress(a));
        rest.forEach((p, i) => {
          const pr = progress(p);
          out.push({
            id: p.id, rank: fin.length + i + 1,
            points: Math.max(5, Math.min(cap, Math.round(pr * 50))),
            detail: `진행 ${Math.round(pr * 100)}%`,
          });
        });
        return out;
      },
    };
  },
});
