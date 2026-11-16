import { useEffect, useState } from 'react';
import { TICK_RATE } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';

/** 현재 단계가 끝날 때까지 남은 초(소수). 일시정지 중에는 멈춘다. */
export function useSecondsLeft(hz = 10): number {
  const end = useStore((s) => s.room?.phaseEndTick ?? 0);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000 / hz);
    return () => clearInterval(t);
  }, [hz]);
  if (!end) return 0;
  return Math.max(0, (end - net.serverTick()) / TICK_RATE);
}

export function useTicker(hz: number) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000 / hz);
    return () => clearInterval(t);
  }, [hz]);
}

export function usePortrait(): boolean {
  const [p, setP] = useState(() => window.innerHeight > window.innerWidth);
  useEffect(() => {
    const f = () => setP(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return p;
}
