import { useMemo, useRef, useState } from 'react';
import { DEFAULT_BANK, LEVEL_LABEL, SUBJECTS, UNIT_LABEL, UNIT_SHORT, cleanBank, type BankQ, type QLevel } from '@shared';
import { net } from '../game/net';

const KEY = 'cp40:bank';
const LEVELS: QLevel[] = ['easy', 'normal', 'hard'];

const VERSION_KEY = 'cp40:bankVersion';
const VERSION = 3; // 2: 과학탐구실험1·2 추가, 3: 세계시민과 지리·한국사1·2·언어생활과 한자 추가

export function loadBank(): BankQ[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      let b = cleanBank(JSON.parse(raw));
      if (b.length) {
        // 예전에 저장해 둔 문제은행에는 나중에 추가된 기본 문제가 없다 → 한 번만 덧붙여 준다
        const saved = Number(localStorage.getItem(VERSION_KEY) ?? 1);
        if (saved < VERSION) {
          const have = new Set(b.map((q) => q.id));
          // 저장한 뒤에 새로 생긴 과목의 문제만 덧붙인다(직접 지운 예전 문제가 되살아나지 않게)
          const since = saved < 2 ? 4 : 22;
          b = [...b, ...DEFAULT_BANK.filter((q) => q.unit > since && !have.has(q.id))];
          localStorage.setItem(KEY, JSON.stringify(b));
          localStorage.setItem(VERSION_KEY, String(VERSION));
        }
        return b;
      }
    }
  } catch { /* 깨진 값이면 기본 문제 */ }
  return DEFAULT_BANK;
}

const blank = (): BankQ => ({ id: `my${Date.now().toString(36)}`, unit: 3, level: 'normal', text: '', options: ['', '', '', ''], answer: 0, explain: '' });

/**
 * 교사용 문제은행 편집 화면.
 * 문제는 이 브라우저에 저장되고, 방이 열려 있으면 저장할 때마다 서버에도 적용된다.
 * 파일로 내보내고 가져올 수 있어 다른 컴퓨터로 옮길 수 있다.
 */
export function BankEditor({ onClose }: { onClose: () => void }) {
  const [bank, setBank] = useState<BankQ[]>(loadBank);
  const [unit, setUnit] = useState(0);
  const [subj, setSubj] = useState('');
  const [level, setLevel] = useState<QLevel | ''>('');
  const [edit, setEdit] = useState<BankQ | null>(null);
  const [msg, setMsg] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const subjUnits = SUBJECTS.find((x) => x.id === subj)?.units;
  const shown = useMemo(() => bank.filter((q) => (!subjUnits || subjUnits.includes(q.unit)) && (!unit || q.unit === unit) && (!level || q.level === level)), [bank, unit, level, subj]);

  const save = (next: BankQ[], note: string) => {
    setBank(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); localStorage.setItem(VERSION_KEY, String(VERSION)); } catch { setMsg('이 브라우저에 저장하지 못했어요. 파일로 내보내 두세요.'); return; }
    net.hostCmd({ type: 'bank', bank: next }); // 방이 열려 있을 때만 전달된다
    setMsg(note);
  };
  const valid = edit && edit.text.trim() && edit.options.every((o) => o.trim());
  const commit = () => {
    if (!edit || !valid) return;
    const exists = bank.some((q) => q.id === edit.id);
    save(exists ? bank.map((q) => (q.id === edit.id ? edit : q)) : [edit, ...bank], exists ? '문제를 고쳤어요.' : '문제를 추가했어요.');
    setEdit(null);
  };
  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(bank, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'class-party-40_문제은행.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const importJson = async (f: File) => {
    try {
      const b = cleanBank(JSON.parse(await f.text()));
      if (!b.length) { setMsg('쓸 수 있는 문제가 없는 파일이에요.'); return; }
      save(b, `${b.length}문제를 가져왔어요.`);
    } catch { setMsg('파일을 읽지 못했어요. 내보내기로 만든 JSON 파일인지 확인해 주세요.'); }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/50 p-2 sm:p-4">
      <div className="card flex h-full max-h-[760px] w-full max-w-4xl flex-col gap-3 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-2xl">문제은행 <span className="text-base opacity-60">{bank.length}문제</span></h2>
            <div className="text-sm opacity-70">7개 과목. 출제할 때 보기 순서는 자동으로 섞여요.</div>
          </div>
          <button className="btn-ghost !py-2 !text-base" onClick={onClose}>닫기</button>
        </div>

        {edit ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            <div className="flex flex-wrap gap-2">
              <select aria-label="과목" className="rounded-full border-2 border-ink/10 bg-white px-3 py-1 font-display text-sm"
                value={SUBJECTS.find((x) => x.units.includes(edit.unit))?.id ?? 'chem'}
                onChange={(e) => setEdit({ ...edit, unit: SUBJECTS.find((x) => x.id === e.target.value)!.units[0] })}>
                {SUBJECTS.map((sb) => <option key={sb.id} value={sb.id}>{sb.name}</option>)}
              </select>
              {(SUBJECTS.find((x) => x.units.includes(edit.unit))?.units ?? []).map((u) => (
                <button key={u} className={`chip ${edit.unit === u ? '!bg-grape !text-white' : ''}`} onClick={() => setEdit({ ...edit, unit: u })}>{UNIT_SHORT[u]}</button>
              ))}
              <span className="w-full" />
              {LEVELS.map((l) => (
                <button key={l} className={`chip ${edit.level === l ? '!bg-bubble !text-white' : ''}`} onClick={() => setEdit({ ...edit, level: l })}>{LEVEL_LABEL[l]}</button>
              ))}
            </div>
            <label className="font-display" htmlFor="bq-text">문제</label>
            <textarea id="bq-text" className="field !text-base" rows={3} maxLength={400} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} placeholder="예: 발열 반응에서 반응 엔탈피(ΔH)의 부호는?" />
            <div className="font-display">보기 <span className="text-sm opacity-60">(정답인 보기의 동그라미를 눌러 주세요)</span></div>
            {edit.options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <button aria-label={`보기 ${i + 1}을 정답으로`} onClick={() => setEdit({ ...edit, answer: i })}
                  className={`h-9 w-9 shrink-0 rounded-full border-4 font-display ${edit.answer === i ? 'border-mint bg-mint' : 'border-ink/20 bg-white'}`}>{edit.answer === i ? '⭕' : ''}</button>
                <input id={`bq-opt-${i}`} className="field !py-2 !text-base" maxLength={120} value={o} placeholder={`보기 ${i + 1}`}
                  onChange={(e) => setEdit({ ...edit, options: edit.options.map((x, k) => (k === i ? e.target.value : x)) })} />
              </div>
            ))}
            <label className="font-display" htmlFor="bq-explain">해설 <span className="text-sm opacity-60">(채점 뒤 학생 화면에 보여요)</span></label>
            <textarea id="bq-explain" className="field !text-base" rows={2} maxLength={600} value={edit.explain} onChange={(e) => setEdit({ ...edit, explain: e.target.value })} />
            <div className="flex gap-2">
              <button className="btn-grape" disabled={!valid} onClick={commit}>저장</button>
              <button className="btn-ghost" onClick={() => setEdit(null)}>취소</button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="과목" className="rounded-full border-2 border-ink/10 bg-white px-3 py-1 font-display text-sm" value={subj}
                onChange={(e) => { setSubj(e.target.value); setUnit(0); }}>
                <option value="">전체 과목</option>
                {SUBJECTS.map((sb) => <option key={sb.id} value={sb.id}>{sb.name}</option>)}
              </select>
              {(SUBJECTS.find((x) => x.id === subj)?.units ?? []).map((u) => <button key={u} title={UNIT_LABEL[u]} className={`chip ${unit === u ? '!bg-grape !text-white' : ''}`} onClick={() => setUnit(unit === u ? 0 : u)}>{UNIT_SHORT[u]}</button>)}
              <span className="opacity-30">|</span>
              <button className={`chip ${level === '' ? '!bg-bubble !text-white' : ''}`} onClick={() => setLevel('')}>전체 난이도</button>
              {LEVELS.map((l) => <button key={l} className={`chip ${level === l ? '!bg-bubble !text-white' : ''}`} onClick={() => setLevel(l)}>{LEVEL_LABEL[l]}</button>)}
              <span className="ml-auto text-sm opacity-70">{shown.length}문제 표시</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {shown.map((q) => (
                <div key={q.id} className="rounded-2xl bg-cream p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex gap-1 text-xs">
                        <span className="rounded-full bg-grape px-2 text-white">{UNIT_SHORT[q.unit] ?? q.unit}</span>
                        <span className="rounded-full bg-bubble px-2 text-white">{LEVEL_LABEL[q.level]}</span>
                      </div>
                      <div className="whitespace-pre-line font-display">{q.text}</div>
                      <div className="mt-1 grid gap-x-3 text-sm sm:grid-cols-2">
                        {q.options.map((o, i) => <div key={i} className={i === q.answer ? 'font-bold text-[#2f9e44]' : 'opacity-70'}>{i === q.answer ? '⭕' : '·'} {o}</div>)}
                      </div>
                      {q.explain && <div className="mt-1 text-sm opacity-70">해설: {q.explain}</div>}
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <button className="chip" onClick={() => setEdit({ ...q, options: [...q.options] })}>고치기</button>
                      <button className="chip hover:!bg-bubble hover:!text-white" onClick={() => save(bank.filter((x) => x.id !== q.id), '문제를 지웠어요.')}>지우기</button>
                    </div>
                  </div>
                </div>
              ))}
              {shown.length === 0 && <div className="py-8 text-center opacity-60">이 조건에 맞는 문제가 없어요. 조건에 맞는 문제가 모자라면 다른 문제로 채워서 출제돼요.</div>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-bubble !py-2 !text-base" onClick={() => { setEdit(blank()); setMsg(''); }}>＋ 문제 추가</button>
              <button className="btn-mint !py-2 !text-base" onClick={exportJson}>⬇ 파일로 내보내기</button>
              <button className="btn-ghost !py-2 !text-base" onClick={() => file.current?.click()}>⬆ 파일에서 가져오기</button>
              <button className="btn-ghost !py-2 !text-base" onClick={() => save(DEFAULT_BANK, `기본 문제 ${DEFAULT_BANK.length}개로 되돌렸어요.`)}>기본 문제로 되돌리기</button>
              <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
              {msg && <span className="font-display text-sm text-grape">{msg}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
