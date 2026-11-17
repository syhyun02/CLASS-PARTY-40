import { useEffect, useMemo, useState } from 'react';
import { GAMES, QUIZ_PADS, chemRowZ, getGame, type RoomState, type RoundRow } from '@shared';
import { net } from '../game/net';
import { play, setMusicPref, setSfx, soundPrefs } from '../game/sound';
import { setQuality, useStore, type Quality } from '../game/store';
import { useSecondsLeft, useTicker } from './hooks';

export function Blob({ color, size = 28 }: { color: string; size?: number }) {
  return (
    <span className="relative inline-block shrink-0 rounded-full shadow-popsm" style={{ width: size, height: size * 1.1, background: color }}>
      <span className="absolute rounded-full bg-white" style={{ width: size * 0.22, height: size * 0.26, left: size * 0.2, top: size * 0.28 }} />
      <span className="absolute rounded-full bg-white" style={{ width: size * 0.22, height: size * 0.26, right: size * 0.2, top: size * 0.28 }} />
    </span>
  );
}

/** 랜덤 미니게임 추첨: 카드가 빠르게 돌아가다 뽑힌 게임에서 멈춘다. */
export function DrawOverlay({ room }: { room: RoomState }) {
  const left = useSecondsLeft(20);
  const game = getGame(room.gameId ?? '');
  const pool = useMemo(() => {
    const ids = room.config.games.length > 1 ? room.config.games : GAMES.map((g) => g.id); // 한 종뿐이면 연출용으로 전체를 돌린다
    return ids.map((id) => getGame(id)!).filter(Boolean);
  }, [room.config.games]);
  const spinning = left > 2.6;
  const e = Math.max(0, 6 - left); // 시계 동기화 전에는 남은 시간이 6초를 넘을 수 있다
  const shown = (spinning ? pool[Math.floor(e * (4 + e * 2.2)) % pool.length] : game) ?? game ?? GAMES[0];
  useEffect(() => { play(spinning ? 'tick' : 'reveal'); }, [shown?.id, spinning]);
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-grape/70 p-4 backdrop-blur-sm">
      <div className="chip animate-rise">ROUND {room.round} / {room.config.rounds}</div>
      <div className="font-display text-2xl text-white title-stroke">이번 게임은…</div>
      <div key={spinning ? 'spin' : 'done'} className={`card flex w-[min(420px,86vw)] flex-col items-center gap-1 text-center ${spinning ? '' : 'animate-pop'}`}>
        <div className={`text-6xl ${spinning ? 'animate-wiggle' : 'animate-floaty'}`}>{shown.emoji}</div>
        <div className="font-display text-3xl">{shown.name}</div>
        <div className={`text-base ${spinning ? 'opacity-0' : 'opacity-80'}`}>{game?.howTo}</div>
      </div>
    </div>
  );
}

export function CountdownOverlay({ room }: { room: RoomState }) {
  const left = useSecondsLeft(20);
  const n = Math.ceil(left - 1);
  const game = getGame(room.gameId ?? '');
  useEffect(() => { if (n > 0 && n <= 3) play('beep'); }, [n]);
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2">
      <div className="chip">{game?.emoji} {game?.name}</div>
      <div key={n} className="animate-pop font-display text-[min(34vh,180px)] leading-none text-white" style={{ WebkitTextStroke: '6px #3b2f63', paintOrder: 'stroke fill' }}>
        {n > 0 ? n : '출발!'}
      </div>
      <div className="chip">{game?.howTo}</div>
    </div>
  );
}

/** 경기 중 상단 정보: 남은 시간, 내 순위, 완주 인원, 진행 막대 */
export function RaceHud({ room, myId }: { room: RoomState; myId: number | null }) {
  useTicker(5);
  const left = useSecondsLeft(4);
  const players = net.renderPlayers();
  const track = net.level?.track;
  const done = room.players.filter((p) => p.place !== null);
  const racers = room.players.filter((p) => p.active).length;
  const mine = room.players.find((p) => p.id === myId);
  const me = players.find((p) => p.id === myId);
  // 실시간 순위: 완주자 수 + 나보다 앞선 사람 수
  let rank = mine?.place ?? null;
  if (rank === null && me) rank = done.length + 1 + players.filter((p) => p.id !== myId && p.z > me.z && !done.some((d) => d.id === p.id)).length;
  const prog = (z: number) => (track ? Math.max(0, Math.min(1, (z - track.z0) / (track.z1 - track.z0))) : 0);
  const lead = players.reduce((m, p) => Math.max(m, prog(p.z)), 0);
  const urgent = left <= 20;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
      <div className="chip tabular-nums">{rank !== null && myId !== null ? <><b className="text-xl text-bubble">{rank}</b>위 / {racers}명</> : `${racers}명 경기 중`}</div>
      <div className="flex flex-1 flex-col items-center gap-1">
        <div className={`chip tabular-nums text-lg ${urgent ? 'animate-wiggle !bg-bubble !text-white' : ''}`}>⏱ {Math.floor(left / 60)}:{String(Math.floor(left % 60)).padStart(2, '0')}</div>
        {track && (
          <div className="relative h-3 w-[min(46vw,360px)] rounded-full bg-white/70 shadow-popsm">
            <div className="absolute inset-y-0 left-0 rounded-full bg-mint/70" style={{ width: `${lead * 100}%` }} />
            {me && <div className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white" style={{ left: `${prog(me.z) * 100}%`, background: mine?.color }} />}
            <div className="absolute -right-1 -top-2 text-sm">🏁</div>
          </div>
        )}
      </div>
      <div className="chip tabular-nums">🏁 {done.length}명 완주</div>
      {mine?.place != null && room.phase === 'playing' && (
        <div className="absolute inset-x-0 top-24 flex justify-center">
          <div className="card animate-pop px-6 py-3 text-center font-display text-2xl">🎉 {mine.place}위로 완주!</div>
        </div>
      )}
    </div>
  );
}

/** 생존 게임 상단 정보: 남은 시간, 생존 인원, 내 탈락 순위 */
export function SurvivalHud({ room, myId }: { room: RoomState; myId: number | null }) {
  const left = useSecondsLeft(4);
  const racers = room.players.filter((p) => p.active);
  const alive = racers.filter((p) => !p.out).length;
  const mine = room.players.find((p) => p.id === myId);
  const game = getGame(room.gameId ?? '');
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
      <div className="chip">{game?.emoji} {game?.name}</div>
      <div className={`chip tabular-nums text-lg ${left <= 15 ? 'animate-wiggle !bg-bubble !text-white' : ''}`}>⏱ {Math.floor(left / 60)}:{String(Math.floor(left % 60)).padStart(2, '0')}</div>
      <div className="chip tabular-nums">💪 <b className="text-xl text-bubble">{alive}</b> / {racers.length}명 생존</div>
      {mine?.out && (
        <div className="absolute inset-x-0 top-20 flex justify-center">
          <div className="card animate-pop px-6 py-3 text-center font-display text-2xl">💦 탈락! {mine.place}위 · 관전 중</div>
        </div>
      )}
    </div>
  );
}

/** 수집 게임 상단 정보: 남은 시간, 내 점수, 현재 1~3위 */
export function CollectHud({ room, myId }: { room: RoomState; myId: number | null }) {
  const left = useSecondsLeft(4);
  const game = useStore((s) => s.game);
  const scores = [...(game?.scores ?? [])].sort((a, b) => b[1] - a[1]);
  const mine = scores.find((s) => s[0] === myId)?.[1] ?? 0;
  const myRank = scores.findIndex((s) => s[0] === myId) + 1;
  const name = (id: number) => room.players.find((p) => p.id === id);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
      <div className="flex flex-col items-start gap-1">
        <div className="chip tabular-nums">
          {myId !== null ? <>💎 <b key={mine} className="inline-block animate-pop text-xl text-bubble">{mine}</b>점{myRank > 0 && ` · ${myRank}위`}</> : '💎 반짝 보물섬'}
        </div>
        {scores.slice(0, 3).map(([id, v], i) => (
          <div key={id} className="chip flex items-center gap-1 !py-0.5 tabular-nums">
            {['🥇', '🥈', '🥉'][i]} <Blob color={name(id)?.color ?? '#fff'} size={14} /> {name(id)?.name} <b>{v}</b>
          </div>
        ))}
      </div>
      <div className={`chip tabular-nums text-lg ${left <= 10 ? 'animate-wiggle !bg-bubble !text-white' : ''}`}>⏱ {Math.floor(left / 60)}:{String(Math.floor(left % 60)).padStart(2, '0')}</div>
      <div className="w-24" />
    </div>
  );
}

const Timer = ({ left, urgent = 10 }: { left: number; urgent?: number }) => (
  <div className={`chip tabular-nums text-lg ${left <= urgent ? 'animate-wiggle !bg-bubble !text-white' : ''}`}>⏱ {Math.floor(left / 60)}:{String(Math.floor(left % 60)).padStart(2, '0')}</div>
);
const HUD_BAR = 'pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3';

/** 꼬리 지키기: 내가 꼬리를 가졌는지, 모은 시간, 꼬리 수 */
export function TailHud({ room, myId }: { room: RoomState; myId: number | null }) {
  const left = useSecondsLeft(4);
  const game = useStore((s) => s.game);
  const has = myId !== null && (game?.tails ?? []).includes(myId);
  const mine = game?.scores?.find((s) => s[0] === myId)?.[1] ?? 0;
  return (
    <div className={HUD_BAR} style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
      <div className="chip tabular-nums">{myId !== null ? <>🦊 꼬리 <b className="text-xl text-bubble">{mine}</b>초</> : '🦊 꼬리 지키기'}</div>
      <div className="flex flex-col items-center gap-1">
        <Timer left={left} />
        {myId !== null && (
          <div key={String(has)} className={`chip animate-pop !text-base ${has ? '!bg-lemon' : '!bg-white'}`}>
            {has ? '꼬리가 있어요! 도망쳐요 🏃' : '꼬리 가진 친구에게 닿아요!'}
          </div>
        )}
      </div>
      <div className="chip tabular-nums">🦊 {(game?.tails ?? []).length}개</div>
    </div>
  );
}

/**
 * 문제 띠: 화면 위쪽에 얇게 뜨는 문제 표시. 경기장을 가리지 않도록 두 줄까지만 보이고,
 * 누르면 전체 문제와 보기가 펼쳐진다. 보기는 발판·문 위의 팻말에 항상 떠 있다.
 */
function QuestionStrip({ label, text, extra, progress, urgent, options, answer, children }: {
  label: string; text: string; extra?: React.ReactNode; progress?: number; urgent?: boolean;
  options?: { text: string; color: string }[]; answer?: number; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const multi = text.includes('\n'); // 줄바꿈이 있는 문제(식, 그림 문자)는 자르지 않는다
  return (
    <div className="pointer-events-auto w-[min(460px,50vw)] cursor-pointer rounded-2xl bg-white/85 px-3 py-1.5 text-center shadow-popsm backdrop-blur-sm" onClick={() => setOpen(!open)}>
      <div className="flex items-center justify-between text-[11px] leading-none opacity-60"><span>{label}</span><span>{open ? '접기 ▲' : '펼치기 ▼'}</span></div>
      {extra}
      <div className={`whitespace-pre-line font-display text-sm leading-snug sm:text-lg ${open || multi ? '' : 'line-clamp-2'}`}>{text}</div>
      {open && options && (
        <div className="mt-1 grid grid-cols-2 gap-1 text-left">
          {options.map((o, i) => (
            <div key={i} className={`rounded-lg border-2 px-1.5 py-0.5 text-xs leading-tight sm:text-sm ${answer !== undefined && answer >= 0 ? (i === answer ? 'bg-mint' : 'opacity-40') : 'bg-white'}`} style={{ borderColor: o.color }}>{o.text}</div>
          ))}
        </div>
      )}
      {progress !== undefined && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
          <div className={`h-full rounded-full ${urgent ? 'bg-bubble' : 'bg-grape'}`} style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
        </div>
      )}
      {children}
    </div>
  );
}

/** 해설: 조이스틱과 버튼 사이, 화면 아래 가운데에 작게 띄운다. */
function ExplainStrip({ title, ok, text }: { title: string; ok: boolean; text?: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
      <div className="w-[min(520px,46vw)] animate-pop rounded-2xl bg-cream/90 px-3 py-1.5 text-left text-xs leading-snug shadow-popsm backdrop-blur-sm sm:text-sm">
        <b className={`font-display ${ok ? 'text-[#2f9e44]' : 'text-bubble'}`}>{title}</b>{text ? <> 💡 {text}</> : null}
      </div>
    </div>
  );
}

/** 정답 발판: 문제 띠 + 남은 시간 + 채점 결과와 해설 */
export function QuizHud({ myId }: { room: RoomState; myId: number | null }) {
  useTicker(10);
  const game = useStore((s) => s.game);
  const quiz = net.level?.quiz ?? [];
  const t = net.levelTime();
  let qi = -1;
  for (let i = 0; i < quiz.length; i++) if (quiz[i].at <= t) qi = i;
  const q = qi >= 0 ? quiz[qi] : null;
  const mine = game?.scores?.find((s) => s[0] === myId)?.[1] ?? 0;
  const revealed = !!q && t >= q.revealAt;
  const graded = game?.quiz?.index === qi ? game.quiz : null;
  const ok = graded && myId !== null ? graded.correct.includes(myId) : null;
  const left = q ? Math.max(0, q.revealAt - t) : 0;
  const flashing = !!q?.flash && t - q.at < 3.5;
  return (
    <>
      <div className={HUD_BAR} style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
        <div className="chip tabular-nums">{myId !== null ? <>✅ <b className="text-xl text-bubble">{mine}</b> / {quiz.length}</> : '✅ 정답 발판'}</div>
        {q ? (
          <QuestionStrip
            key={qi}
            label={`문제 ${qi + 1} / ${quiz.length}${revealed ? '' : ` · ${Math.ceil(left)}초`}`}
            text={q.flash && flashing ? '잘 기억해 두세요!' : q.text}
            progress={revealed ? undefined : left / (q.revealAt - q.at)} urgent={left < 3}
            options={q.options.map((o, i) => ({ text: o, color: QUIZ_PADS[i].color }))} answer={revealed ? q.answer : undefined}
            extra={<>
              {q.flash && flashing && <div className="font-display text-2xl tracking-wider">{q.flash}</div>}
              {q.word && <div className="font-display text-3xl leading-none" style={{ color: q.color, WebkitTextStroke: '5px #2b2145', paintOrder: 'stroke fill' }}>{q.word}</div>}
            </>}
          />
        ) : <div className="chip">곧 첫 문제가 나와요</div>}
        <div className="w-16" />
      </div>
      {revealed && q && (ok !== null || q.explain) && (
        <ExplainStrip key={qi} ok={ok !== false} title={ok === null ? `정답: ${q.options[q.answer] ?? ''}` : ok ? '⭕ 정답!' : `❌ 정답은 "${q.options[q.answer] ?? ''}"`} text={q.explain} />
      )}
    </>
  );
}

/** 화학 미로: 레이스 정보 + 지금 풀 문제 띠 + 방금 통과한 문제의 해설 */
export function ChemMazeHud({ room, myId }: { room: RoomState; myId: number | null }) {
  useTicker(4);
  const mine = useStore((s) => s.mine);
  const quiz = net.level?.quiz ?? [];
  const me = net.renderPlayers().find((p) => p.isMe);
  // 학생은 자기가 풀 차례인 문제를, 교사 화면은 선두가 풀고 있는 문제를 본다
  const lead = net.renderPlayers().reduce((m, p) => Math.max(m, p.z), 0);
  let qi = myId !== null ? mine.passed : quiz.findIndex((_, i) => chemRowZ(i) > lead - 0.5);
  if (qi < 0) qi = quiz.length;
  const q = quiz[qi];
  const ex = mine.explain;
  // 해설은 다음 문 앞에 닿기 전까지 보여 준다
  const showEx = ex && (!q || !me || me.z < chemRowZ(qi) - 5) ? ex : null;
  return (
    <>
      <RaceHud room={room} myId={myId} />
      {q && (
        <div className="pointer-events-none absolute inset-x-0 top-[4.4rem] z-10 flex justify-center px-3">
          <QuestionStrip key={qi} label={`문제 ${qi + 1} / ${quiz.length} · ${myId !== null ? '정답이 걸린 문으로!' : '학생마다 보기 순서가 달라요'}`} text={q.text} />
        </div>
      )}
      {showEx && <ExplainStrip key={showEx.q} ok title={`⭕ 문제 ${showEx.q + 1} 통과${showEx.first ? ' · 한 번에 정답!' : ''}`} text={showEx.text} />}
    </>
  );
}

/** 게임 장르에 맞는 경기 중 HUD */
export function GameHud({ room, myId }: { room: RoomState; myId: number | null }) {
  if (room.gameId === 'tail') return <TailHud room={room} myId={myId} />;
  if (room.gameId === 'answer') return <QuizHud room={room} myId={myId} />;
  if (room.gameId === 'chemmaze') return <ChemMazeHud room={room} myId={myId} />;
  const genre = getGame(room.gameId ?? '')?.genre;
  if (genre === 'race') return <RaceHud room={room} myId={myId} />;
  if (genre === 'collect') return <CollectHud room={room} myId={myId} />;
  return <SurvivalHud room={room} myId={myId} />;
}

function Row({ r, me, showPoints, delta }: { r: RoundRow; me: boolean; showPoints: boolean; delta?: number }) {
  return (
    <div className={`flex items-center gap-2 rounded-2xl px-3 py-1.5 ${me ? 'bg-lemon' : 'bg-white/80'}`}>
      <div className="w-8 text-center font-display text-lg tabular-nums">{r.rank}</div>
      <Blob color={r.color} size={22} />
      <div className="min-w-0 flex-1 truncate font-display">{r.name}</div>
      {showPoints && <div className="hidden text-sm opacity-70 sm:block">{r.detail}</div>}
      {showPoints && <div className="w-12 text-right font-display text-bubble tabular-nums">+{r.points}</div>}
      {delta !== undefined && delta !== 0 && <div className={`w-9 text-right text-sm font-display tabular-nums ${delta > 0 ? 'text-[#2f9e44]' : 'text-bubble'}`}>{delta > 0 ? `▲${delta}` : `▼${-delta}`}</div>}
      <div className="w-14 text-right font-display tabular-nums">{r.total}</div>
    </div>
  );
}

/** 누적 점수 순위(동점은 같은 순위) */
export function standings(room: RoomState): RoundRow[] {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  let rank = 0, prev = -1;
  return sorted.map((p, i) => {
    if (p.score !== prev) { rank = i + 1; prev = p.score; }
    return { id: p.id, name: p.name, color: p.color, rank, points: 0, detail: '', total: p.score };
  });
}

/** 이번 라운드 전의 누적 순위(순위 변동 화살표용) */
function previousRanks(room: RoomState): Map<number, number> {
  const last = new Map((room.lastResult ?? []).map((r) => [r.id, r.points]));
  const before = [...room.players].map((p) => ({ id: p.id, v: p.score - (last.get(p.id) ?? 0) })).sort((a, b) => b.v - a.v);
  const out = new Map<number, number>();
  let rank = 0, prev = -1;
  before.forEach((p, i) => { if (p.v !== prev) { rank = i + 1; prev = p.v; } out.set(p.id, rank); });
  return out;
}

export function ResultOverlay({ room, myId }: { room: RoomState; myId: number | null }) {
  const left = useSecondsLeft(4);
  const [tab, setTab] = useState<'round' | 'total'>('round');
  // 절반쯤 지나면 누적 순위로 넘어간다
  useEffect(() => { if (left > 0 && left < 5.5) setTab('total'); }, [left < 5.5]);
  const rows = tab === 'round' ? room.lastResult ?? [] : standings(room);
  const top = rows.slice(0, 8);
  const mine = rows.find((r) => r.id === myId);
  const game = getGame(room.gameId ?? '');
  const prevRank = useMemo(() => previousRanks(room), [room.lastResult]);
  const delta = (r: RoundRow) => (tab === 'total' && room.round > 1 ? (prevRank.get(r.id) ?? r.rank) - r.rank : undefined);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-ink/45 p-3 backdrop-blur-sm">
      <div className="card flex max-h-full w-[min(560px,96vw)] flex-col gap-2 overflow-hidden animate-pop">
        <div className="flex items-center justify-between gap-2">
          <div className="font-display text-xl">{tab === 'round' ? `${game?.emoji} ${room.round}라운드 결과` : '🏆 누적 순위'}</div>
          <div className="flex gap-1">
            <button className={`chip ${tab === 'round' ? '!bg-grape !text-white' : ''}`} onClick={() => setTab('round')}>이번 판</button>
            <button className={`chip ${tab === 'total' ? '!bg-grape !text-white' : ''}`} onClick={() => setTab('total')}>누적</button>
          </div>
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto">
          {top.map((r, i) => <div key={r.id} className="animate-rise" style={{ animationDelay: `${i * 0.05}s` }}><Row r={r} me={r.id === myId} showPoints={tab === 'round'} delta={delta(r)} /></div>)}
          {mine && !top.includes(mine) && <><div className="text-center leading-none opacity-50">⋮</div><Row r={mine} me showPoints={tab === 'round'} delta={delta(mine)} /></>}
        </div>
        <div className="text-center text-sm opacity-70">
          {room.round >= room.config.rounds ? '곧 시상식이 시작돼요' : `다음 게임 추첨까지 ${Math.ceil(left)}초`}
        </div>
      </div>
    </div>
  );
}

/** 최종 시상식: 1~3위 시상대 + 전체 순위표 */
export function FinalOverlay({ room, myId, children }: { room: RoomState; myId: number | null; children?: React.ReactNode }) {
  const rows = standings(room);
  const podium = [rows[1], rows[0], rows[2]];
  const heights = ['h-20', 'h-28', 'h-14'];
  const medals = ['🥈', '🥇', '🥉'];
  // 처음 5초는 3D 시상대를 보여 주고, 그 뒤에 순위표를 띄운다
  const [open, setOpen] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOpen(true), 5000); return () => clearTimeout(t); }, []);
  if (!open) return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex flex-col items-center gap-2">
      <div className="card animate-pop px-6 py-2 font-display text-3xl">🎊 최종 시상식 🎊</div>
      <button className="btn-grape pointer-events-auto !py-2 !text-base" onClick={() => setOpen(true)}>🏆 순위 보기</button>
    </div>
  );
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-grape/60 p-3 backdrop-blur-sm">
      <div className="card flex max-h-full w-[min(760px,97vw)] flex-col gap-3 overflow-hidden">
        <div className="text-center font-display text-3xl">🎊 최종 시상식 🎊</div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
          <div className="flex items-end justify-center gap-2 sm:w-1/2">
            {podium.map((r, i) => r && (
              <div key={r.id} className="flex w-24 flex-col items-center animate-rise" style={{ animationDelay: `${[0.5, 0.9, 0.1][i]}s` }}>
                <div className="animate-floaty"><Blob color={r.color} size={i === 1 ? 54 : 42} /></div>
                <div className="max-w-full truncate font-display">{r.name}</div>
                <div className={`flex w-full flex-col items-center justify-start rounded-t-2xl bg-lemon pt-1 font-display shadow-popsm ${heights[i]}`}>
                  <span className="text-2xl">{medals[i]}</span><span className="tabular-nums">{r.total}점</span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {rows.map((r) => <Row key={r.id} r={r} me={r.id === myId} showPoints={false} />)}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {children}
          <button className="btn-ghost !py-2 !text-base" onClick={() => setOpen(false)}>시상대 보기</button>
        </div>
      </div>
    </div>
  );
}

export function SettingsButton({ host = false }: { host?: boolean }) {
  const quality = useStore((s) => s.quality);
  useStore((s) => s.soundTick);
  const studentSound = useStore((s) => s.room?.config.studentSound !== false);
  const [open, setOpen] = useState(false);
  const label: Record<Quality, string> = { low: '낮음', medium: '보통', high: '높음' };
  const muted = !soundPrefs.sfx || (!host && !studentSound);
  const full = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
  return (
    <div className="absolute bottom-3 left-1/2 z-30 -translate-x-1/2 sm:bottom-auto sm:left-auto sm:right-3 sm:top-14 sm:translate-x-0">
      <button className="chip" onClick={() => setOpen(!open)} aria-label="설정">⚙ {muted ? '🔇' : '🔊'} 화질 {label[quality]}</button>
      {open && (
        <div className="card absolute bottom-10 left-1/2 flex w-max -translate-x-1/2 flex-col gap-2 !p-3 sm:bottom-auto sm:left-auto sm:right-0 sm:top-10 sm:translate-x-0">
          <div className="flex items-center gap-2">
            <span className="w-12 font-display text-sm">화질</span>
            {(['low', 'medium', 'high'] as Quality[]).map((q) => (
              <button key={q} className={`chip ${q === quality ? '!bg-grape !text-white' : ''}`} onClick={() => setQuality(q)}>{label[q]}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 font-display text-sm">소리</span>
            <button className={`chip ${soundPrefs.sfx ? '!bg-mint' : ''}`} onClick={() => setSfx(!soundPrefs.sfx)}>{soundPrefs.sfx ? '🔊 효과음 켜짐' : '🔇 효과음 꺼짐'}</button>
            {host && <button className={`chip ${soundPrefs.music ? '!bg-mint' : ''}`} onClick={() => setMusicPref(!soundPrefs.music)}>{soundPrefs.music ? '🎵 음악 켜짐' : '음악 꺼짐'}</button>}
          </div>
          {!host && !studentSound && <div className="text-xs opacity-70">선생님이 학생 기기 소리를 꺼 두었어요.</div>}
          {full && (
            <button className="chip self-start" onClick={() => { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); setOpen(false); }}>⛶ 전체 화면</button>
          )}
        </div>
      )}
    </div>
  );
}

/** 연결 끊김·일시정지·그래픽 중단 안내 */
export function StatusOverlays({ room }: { room: RoomState | null }) {
  const online = useStore((s) => s.online);
  const lost = useStore((s) => s.contextLost);
  const notice = useStore((s) => s.notice);
  if (lost) return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-ink/80 p-6 text-center text-white">
      <div className="font-display text-2xl">그래픽이 잠시 멈췄어요</div>
      <div>다시 불러오면 같은 자리로 돌아갑니다.</div>
      <button className="btn-bubble" onClick={() => location.reload()}>다시 불러오기</button>
    </div>
  );
  if (!online) return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-ink/70 text-white">
      <div className="animate-floaty text-5xl">📡</div>
      <div className="font-display text-2xl">다시 연결하는 중…</div>
      <div className="opacity-80">점수와 자리는 그대로 남아 있어요</div>
    </div>
  );
  if (notice) return (
    <div className="pointer-events-none absolute inset-x-0 top-24 z-40 flex justify-center px-3">
      <div className="card animate-pop !bg-lemon !py-2 font-display">{notice}</div>
    </div>
  );
  if (room?.paused) return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-ink/50">
      <div className="card font-display text-3xl">⏸ 잠깐 멈춤</div>
    </div>
  );
  return null;
}
