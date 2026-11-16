import { quizPadAt, rankPoints, type CollectState } from '@shared';
import type { GameCtx, MinigameRuntime, MinigameServer, RoundOutcome } from './types';

/**
 * 정답 발판: 문제마다 오답 발판이 사라지는 순간, 정답 발판 위에 서 있던 사람이 정답.
 * 문제와 정답은 맵 데이터(level.quiz)에 들어 있다. 틀려도 탈락하지 않고 맞힌 개수로 순위를 매긴다.
 */
export const quizGame = (id: string): MinigameServer => ({
  id,
  create(ctx: GameCtx): MinigameRuntime {
    const quiz = ctx.level.quiz ?? [];
    const right = new Map<number, number>();
    let next = 0;
    return {
      onTick() {
        if (next >= quiz.length || ctx.levelTime() < quiz[next].revealAt) return;
        const q = quiz[next];
        const correct: number[] = [];
        for (const p of ctx.players) {
          if (!p.connected) continue;
          if (p.state.y > -0.6 && quizPadAt(p.state.x, p.state.z) === q.answer) {
            correct.push(p.id);
            right.set(p.id, (right.get(p.id) ?? 0) + 1);
          }
        }
        const st: CollectState = { quiz: { index: next, correct }, scores: [...right.entries()] };
        ctx.publish(st);
        next++;
      },
      canMove: () => true,
      isOver: () => false,
      outcome(): RoundOutcome[] {
        const sorted = [...ctx.players].sort((a, b) => (right.get(b.id) ?? 0) - (right.get(a.id) ?? 0));
        let rank = 0, prev = -1;
        return sorted.map((p, i) => {
          const v = right.get(p.id) ?? 0;
          if (v !== prev) { rank = i + 1; prev = v; }
          return { id: p.id, rank, points: v > 0 ? rankPoints(rank) : 5, detail: `${quiz.length}문제 중 ${v}개 정답` };
        });
      },
    };
  },
});
