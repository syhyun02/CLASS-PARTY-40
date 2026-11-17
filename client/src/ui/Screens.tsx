import { useState } from 'react';
import { GAMES, LEVEL_LABEL, PLAYER_COLORS, SUBJECTS, UNIT_SHORT, subjectOf, type GameMode, type QLevel } from '@shared';
import { net } from '../game/net';
import { useStore } from '../game/store';
import { BankEditor } from './BankEditor';
import { Blob } from './Overlays';

const MODES: { id: GameMode; title: string; sub: string; emoji: string; ready: boolean }[] = [
  { id: 'play', title: '순수 놀이 모드', sub: '달리고 점프하고 피하는 3D 파티 게임', emoji: '🎈', ready: true },
  { id: 'chem', title: '교과 퀴즈 모드', sub: '물질과 에너지 3·4단원 · 과학탐구실험1·2 개념 퀴즈가 섞여 나와요', emoji: '⚗️', ready: true },
];

function Shell({ children, back }: { children: React.ReactNode; back?: () => void }) {
  return (
    <div className="party-bg flex min-h-full flex-col items-center justify-center gap-4 p-4">
      {back && <button className="chip absolute left-3 top-3" onClick={back}>← 처음으로</button>}
      {children}
    </div>
  );
}

export function Home() {
  const set = useStore((s) => s.set);
  const notice = useStore((s) => s.notice);
  return (
    <Shell>
      <div className="text-center">
        <div className="flex justify-center gap-2">
          {PLAYER_COLORS.slice(0, 6).map((c, i) => (
            <span key={c} className="animate-floaty" style={{ animationDelay: `${i * 0.25}s` }}><Blob color={c} size={34} /></span>
          ))}
        </div>
        <h1 className="mt-2 font-display text-5xl text-white title-stroke sm:text-7xl">CLASS PARTY <span className="text-lemon">40</span></h1>
        <p className="mt-1 font-display text-lg text-ink/80">우리 반 40명이 한 경기장에서 겨루는 3D 파티 게임</p>
      </div>
      {notice && <div className="card !bg-lemon !py-2 font-display">{notice}</div>}
      <div className="grid w-full max-w-2xl gap-3 sm:grid-cols-2">
        <button className="card flex flex-col items-center gap-1 text-center transition active:translate-y-1" onClick={() => set({ screen: 'join', notice: null })}>
          <div className="text-5xl">🙋</div>
          <div className="font-display text-2xl">학생 입장</div>
          <div className="opacity-70">입장 코드로 들어가요</div>
        </button>
        <button className="card flex flex-col items-center gap-1 text-center transition active:translate-y-1" onClick={() => set({ screen: 'hostSetup', notice: null })}>
          <div className="text-5xl">🧑‍🏫</div>
          <div className="font-display text-2xl">교사: 방 만들기</div>
          <div className="opacity-70">게임을 고르고 진행해요</div>
        </button>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {MODES.map((m) => (
          <div key={m.id} className="chip !text-base">{m.emoji} {m.title}{!m.ready && <span className="ml-1 opacity-60">(준비 중)</span>}</div>
        ))}
      </div>
    </Shell>
  );
}

export function HostSetup() {
  const set = useStore((s) => s.set);
  const [mode, setMode] = useState<GameMode>('play');
  const [rounds, setRounds] = useState(10);
  const [off, setOff] = useState<string[]>([]); // 추첨에서 뺄 게임
  const [units, setUnits] = useState<number[]>([3, 4]);
  const [levels, setLevels] = useState<QLevel[]>(['easy', 'normal', 'hard']);
  const [bankOpen, setBankOpen] = useState(false);
  const pool = GAMES.filter((g) => g.implemented && g.modes.includes(mode));
  const games = pool.filter((g) => !off.includes(g.id)).map((g) => g.id);
  const subject = subjectOf(units);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? (list.length > 1 ? list.filter((x) => x !== v) : list) : [...list, v]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    const e = await net.createRoom({ mode, rounds, games, chem: { units, levels } });
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <Shell back={() => set({ screen: 'home' })}>
      <div className="card flex w-full max-w-3xl flex-col gap-4">
        <h2 className="font-display text-3xl">방 만들기</h2>
        <section>
          <div className="mb-2 font-display text-lg">1. 게임 모드</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODES.map((m) => (
              <button key={m.id} disabled={!m.ready} onClick={() => setMode(m.id)}
                className={`rounded-2xl border-4 p-3 text-left transition disabled:opacity-50 ${mode === m.id ? 'border-grape bg-grape/10' : 'border-ink/10 bg-white'}`}>
                <div className="font-display text-xl">{m.emoji} {m.title}</div>
                <div className="text-sm opacity-70">{m.sub}</div>
              </button>
            ))}
          </div>
        </section>
        <section>
          <div className="mb-2 font-display text-lg">2. 미니게임 구성 <span className="text-sm opacity-60">(추첨에 넣을 게임)</span></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {pool.map((g) => {
              const on = !off.includes(g.id);
              return (
                <button key={g.id} onClick={() => setOff(on ? [...off, g.id] : off.filter((x) => x !== g.id))}
                  className={`rounded-2xl border-4 p-2 text-center ${on ? 'border-mint bg-mint/20' : 'border-ink/10 bg-white opacity-60'}`}>
                  <div className="text-2xl">{g.emoji}</div>
                  <div className="font-display text-sm leading-tight">{g.name}</div>
                  {mode === 'chem' && g.chem && <div className="text-xs text-grape">교과 문제</div>}
                </button>
              );
            })}
          </div>
        </section>
        {mode === 'chem' && (
          <section>
            <div className="mb-2 font-display text-lg">과목과 출제 범위</div>
            <div className="mb-2 grid gap-2 sm:grid-cols-3">
              {SUBJECTS.map((sb) => (
                <button key={sb.id} onClick={() => setUnits(sb.units)}
                  className={`rounded-2xl border-4 p-2 text-left ${subject?.id === sb.id ? 'border-grape bg-grape/10' : 'border-ink/10 bg-white'}`}>
                  <div className="font-display">{sb.emoji} {sb.name}</div>
                  <div className="text-xs opacity-70">{sb.sub}</div>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(subject?.units ?? []).map((u) => <button key={u} className={`chip ${units.includes(u) ? '!bg-grape !text-white' : 'opacity-60'}`} onClick={() => setUnits(toggle(units, u))}>{UNIT_SHORT[u]}</button>)}
              <span className="opacity-30">|</span>
              {(['easy', 'normal', 'hard'] as QLevel[]).map((l) => <button key={l} className={`chip ${levels.includes(l) ? '!bg-bubble !text-white' : 'opacity-60'}`} onClick={() => setLevels(toggle(levels, l))}>{LEVEL_LABEL[l]}</button>)}
              <button className="btn-ghost !py-1.5 !text-base" onClick={() => setBankOpen(true)}>📚 문제은행 편집</button>
            </div>
          </section>
        )}
        <section className="flex flex-wrap items-center gap-3">
          <div className="font-display text-lg">3. 라운드 수</div>
          <button className="btn-ghost !px-4 !py-1" onClick={() => setRounds(Math.max(1, rounds - 1))}>−</button>
          <div className="w-10 text-center font-display text-2xl tabular-nums">{rounds}</div>
          <button className="btn-ghost !px-4 !py-1" onClick={() => setRounds(Math.min(20, rounds + 1))}>＋</button>
        </section>
        {err && <div className="rounded-2xl bg-bubble/20 p-2 font-display text-bubble">{err}</div>}
        <button className="btn-grape text-2xl" disabled={busy || games.length === 0} onClick={create}>{busy ? '만드는 중…' : '방 만들기'}</button>
      </div>
      {bankOpen && <BankEditor onClose={() => setBankOpen(false)} />}
    </Shell>
  );
}

export function Join({ initialCode }: { initialCode: string }) {
  const set = useStore((s) => s.set);
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState(() => { try { return localStorage.getItem('cp40:name') ?? ''; } catch { return ''; } });
  const [color, setColor] = useState<string>(() => PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = code.length === 6 && name.trim().length > 0;
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try { localStorage.setItem('cp40:name', name.trim()); } catch { /* 무시 */ }
    const e = await net.join(code, name.trim(), color);
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <Shell back={() => set({ screen: 'home' })}>
      <form className="card flex w-full max-w-md flex-col gap-3" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <h2 className="font-display text-3xl">입장하기</h2>
        <label className="font-display" htmlFor="code">입장 코드 6자리</label>
        <input id="code" className="field text-center text-3xl tracking-[0.3em]" inputMode="numeric" autoComplete="off" placeholder="000000"
          value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setErr(null); }} />
        <label className="font-display" htmlFor="name">닉네임</label>
        <input id="name" className="field" maxLength={10} autoComplete="off" placeholder="최대 10글자" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="font-display">캐릭터 색</div>
        <div className="flex flex-wrap gap-2">
          {PLAYER_COLORS.map((c) => (
            <button type="button" key={c} onClick={() => setColor(c)} aria-label={`색 ${c}`}
              className={`rounded-full p-1 transition ${color === c ? 'scale-110 bg-ink/20 ring-4 ring-grape' : ''}`}>
              <Blob color={c} size={30} />
            </button>
          ))}
        </div>
        {err && <div className="rounded-2xl bg-bubble/20 p-2 font-display text-bubble">{err}</div>}
        <button className="btn-bubble text-2xl" disabled={!ok || busy}>{busy ? '들어가는 중…' : '입장!'}</button>
      </form>
    </Shell>
  );
}
