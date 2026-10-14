// The Milestones editor: add the dates that explain your data. Saved to data/milestones.yaml while `make dev` runs,
// in this browser on a static build (the public demo).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { S, emit, useWatch } from '../store';
import { KINDS, MS, msFile, saveMilestones } from '../milestones';

type Row = { date: string; end: string; label: string; kind: string; public: boolean };
const blank = (): Row => ({ date: '', end: '', label: '', kind: 'family', public: false });
const okDate = (s: string) => /^\d{4}-\d{2}(-\d{2})?$/.test(s.trim());

export function MilestonesButton() {
  useWatch(['milestones']);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ghost" type="button" aria-pressed={open} title="Life milestones drawn on every chart" onClick={() => setOpen(true)}>
        Milestones{MS.list.length ? <span className="mono" style={{ marginLeft: 6, opacity: 0.7 }}>{MS.list.length}</span> : null}
      </button>
      {/* a portal: the sticky header's blur would otherwise trap a fixed-position dialog inside it */}
      {open && createPortal(<Editor close={() => setOpen(false)} />, document.body)}
    </>
  );
}

function Editor({ close }: { close: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => MS.list.map(m => ({ date: m.precision === 'month' ? m.date.slice(0, 7) : m.date, end: m.end ?? '', label: m.label, kind: m.kind, public: m.public })));
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [close]);
  const upd = (i: number, p: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const bad = rows.filter(r => r.label.trim() && (!okDate(r.date) || (r.end && !okDate(r.end)))).length;
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const keep = rows.filter(r => r.label.trim() && okDate(r.date));
      const out = await saveMilestones(keep.map(r => ({ date: r.date.trim(), end: r.end.trim() || undefined, label: r.label.trim(), kind: r.kind, public: r.public, precision: r.date.trim().length === 7 ? 'month' : 'day' })));
      setMsg(out);
    } catch (e: any) { setMsg('Could not save: ' + (e?.message || e)); }
    setBusy(false);
  };
  return (
    <div className="ms-modal" role="dialog" aria-modal="true" aria-label="Life milestones" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="ms-box">
        <div className="ms-top">
          <div><div className="eyebrow">Life milestones</div><h3>The dates that explain your data</h3></div>
          <button className="ghost" type="button" onClick={close}>Close</button>
        </div>
        <p className="ms-note">A child born, working from home, a new commute, a move, an injury. Each shows as a faint line (or a band for a period) on every chart with a time axis, on both pages.
          Use a month (<code className="mono">2021-08</code>) when you are not sure of the day. In share mode the labels are hidden unless you tick <b>Public</b>.</p>
        <label className="ms-show"><input type="checkbox" checked={S.showMilestones !== false} onChange={e => { S.showMilestones = e.target.checked; emit('milestones', 'filter'); }} /> Show milestones on the charts</label>
        <div className="ms-rows">
          <div className="ms-row ms-head"><span>Date</span><span>Until (optional)</span><span>What happened</span><span>Kind</span><span>Public</span><span /></div>
          {rows.map((r, i) => (
            <div className="ms-row" key={i}>
              <input className={'sel' + (r.date && !okDate(r.date) ? ' bad' : '')} placeholder="2021-08-14" value={r.date} onChange={e => upd(i, { date: e.target.value })} aria-label="Date" />
              <input className={'sel' + (r.end && !okDate(r.end) ? ' bad' : '')} placeholder="2022-09-06" value={r.end} onChange={e => upd(i, { end: e.target.value })} aria-label="Until" />
              <input className="sel" placeholder="Our daughter was born" value={r.label} maxLength={120} onChange={e => upd(i, { label: e.target.value })} aria-label="What happened" />
              <select className="sel" value={r.kind} onChange={e => upd(i, { kind: e.target.value })} aria-label="Kind" style={{ borderLeft: `3px solid ${KINDS[r.kind]?.c}` }}>
                {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <input type="checkbox" checked={r.public} onChange={e => upd(i, { public: e.target.checked })} aria-label="Public in share mode" />
              <button className="tbtn" type="button" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} aria-label="Remove">Remove</button>
            </div>
          ))}
        </div>
        <div className="ms-actions">
          <button className="ghost" type="button" onClick={() => setRows(rs => [...rs, blank()])}>Add a milestone</button>
          <span className="ms-msg">{bad ? `${bad} date${bad > 1 ? 's' : ''} to fix (2021-08-14 or 2021-08)` : msg}</span>
          <button className="ms-save" type="button" disabled={busy || !!bad} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
        <p className="ms-where">{MS.writable ? <>Saved to <code className="mono">{msFile()}</code>, next to your export and never committed. You can edit that file by hand too.</>
          : <>This build cannot write files, so milestones are kept in this browser. On your own copy, run <code className="mono">make dev</code> and they are saved to <code className="mono">data/milestones.yaml</code>.</>}</p>
      </div>
    </div>
  );
}
