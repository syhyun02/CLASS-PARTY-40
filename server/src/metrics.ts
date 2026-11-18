/** 부하 테스트에서 읽어 가는 서버 지표 */
export const metrics = {
  bytesOut: 0, // 스냅샷 + 자기 상태 메시지의 대략적인 전송량(프레이밍 제외)
  snapshots: 0,
  tickMs: [] as number[], // 최근 틱 처리 시간
  lateTicks: 0, // 예정보다 10ms 넘게 늦게 시작한 틱
  ticks: 0,
  // 입력 처리 통계: 실제로 처리한 입력, 어림해서 미리 처리한 걸음, 그 때문에 버린 입력, 입력 없이 쉰 틱
  inputs: 0, guessed: 0, dropped: 0, idle: 0,
  /** 틱 안 단계별 누적 시간(ms): 물리 월드 갱신, 사람 이동, 몸싸움, 게임 규칙, 보내기 */
  phase: { world: 0, move: 0, bodies: 0, rules: 0, send: 0 },
};

export function recordTick(ms: number) {
  metrics.ticks++;
  metrics.tickMs.push(ms);
  if (metrics.tickMs.length > 3000) metrics.tickMs.splice(0, 1000);
}

export function tickStats() {
  const a = [...metrics.tickMs].sort((x, y) => x - y);
  if (!a.length) return { avg: 0, p99: 0, max: 0 };
  return {
    avg: a.reduce((s, v) => s + v, 0) / a.length,
    p99: a[Math.floor(a.length * 0.99)],
    max: a[a.length - 1],
  };
}
