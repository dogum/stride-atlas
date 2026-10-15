// The Sleep page (#sleep): a deep dive on every night, with its own chapters. Nothing here is correlated with the
// activity data on purpose; milestones are the only context drawn across both pages.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { G, S, emit, useWatch } from '../store';
import { armArrival, countTo, f1, fClock, fDate, fDur, fInt } from '../core';
import { loadSleep } from '../data';
import { ChHead, Panel } from './ui';
import {
  drawBarcode, drawBreathFactors, drawBreathWindows, drawBreathing, drawHypno, drawSleepClock, drawSleepDur, drawSleepMonth, drawSleepSources, drawSleepVitals, drawSleepWeek,
  drawStageTrend, drawTempDev, drawTypicalNight, measured, nightStats, nightsIn, openNight, sleepRecords,
} from '../charts/sleep';

// Breathing is medical: share mode leaves the chapter (and its place in the nav) out, so it never reaches a screenshot or a video
export const SLEEP_CHAPTERS = [['nights', 'Nights'], ['timing', 'Duration & timing'], ['stages', 'Stages'], ['onenight', 'One night'], ['vitals', 'Overnight vitals'], ['breathing', 'Breathing'], ['srecords', 'Records'], ['ssources', 'Sources']];
export const SHARE_HIDDEN = new Set(['breathing']);
const W = ['sleep', 'milestones', 'night'];

export function SleepView() {
  const [state, setState] = useState<'loading' | 'ready' | 'none'>(G.sleep ? 'ready' : G.sleep === null ? 'none' : 'loading');
  useEffect(() => { loadSleep().then(s => { setState(s ? 'ready' : 'none'); emit('sleep'); }); }, []);
  useWatch(['filter', 'sleep', 'share']);
  if (state === 'loading') return <main><div className="empty" style={{ padding: 60 }}>Reading every night…</div></main>;
  if (state === 'none') return (
    <main><section className="chapter" id="nights"><ChHead idx={10} eyebrow="Sleep" title="No sleep records yet">
      Sleep appears here once your export has SleepAnalysis records: an Apple Watch worn to bed, the iPhone's bedtime schedule, or a sleep app or another watch that writes to Health. Run <code className="mono">make sleep export</code> after a new export.
    </ChHead></section></main>
  );
  return (
    <main>
      <SleepHero />
      <section className="chapter" id="timing">
        <ChHead idx={11} eyebrow="Duration & timing" title="How long, and when">Hours asleep every night, when you fall asleep and wake, the shape of a week and of a year.</ChHead>
        <div className="grid">
          <Panel id="sdur" cls="c12" title="Hours asleep, every night" draw={drawSleepDur} watch={W} foot={<span>Asleep is every stage but awake, from the first to the last minute asleep in the night (naps are counted separately). One source per night: rules Z1–Z5.</span>} />
          <Panel id="sclock" cls="c12" title="When you fall asleep and wake" draw={drawSleepClock} watch={W} />
          <Panel id="sweek" cls="c7" title="The week, night by night" draw={drawSleepWeek} watch={W} />
          <Panel id="smonth" cls="c5" title="The year, month by month" draw={drawSleepMonth} watch={W} />
        </div>
      </section>
      <section className="chapter" id="stages">
        <ChHead idx={12} eyebrow="Stages" title="Deep, core and REM">From watchOS 9 the watch splits sleep into stages using motion and heart rate. Estimates, not a sleep lab, but consistent night to night.</ChHead>
        <div className="grid">
          <Panel id="sstage" cls="c7" title="Time in each stage" draw={drawStageTrend} watch={W} />
          <Panel id="styp" cls="c5" title="A typical night" draw={drawTypicalNight} watch={W} />
        </div>
      </section>
      <NightSection />
      <section className="chapter" id="vitals">
        <ChHead idx={13} eyebrow="Overnight vitals" title="What the body does asleep">Heart rate, heart-rate variability, breathing, blood oxygen and wrist temperature, measured only during sleep, so the numbers compare night to night.</ChHead>
        <div className="grid">
          <Panel id="svit" cls="c12" title="Heart, breathing and blood oxygen asleep" draw={drawSleepVitals} watch={W} foot={<><code>HeartRate</code><code>HeartRateVariabilitySDNN</code><code>RespiratoryRate</code><code>OxygenSaturation</code><span>Samples inside each night's sleep, watch only</span></>} />
          <Panel id="stemp" cls="c12" title="Wrist temperature" draw={drawTempDev} watch={W} foot={<><code>AppleSleepingWristTemperature</code><span>One value per night; the baseline is the median of the previous 30</span></>} />
        </div>
      </section>
      {!S.share && <section className="chapter" id="breathing">
        <ChHead idx={17} eyebrow="Breathing" title="Breathing at night">The watch counts brief interruptions to breathing every night, and sends a sleep apnea notification when they stay elevated across a 30-day window. A screening signal, not a diagnosis. Share mode hides this chapter.</ChHead>
        <div className="grid">
          <Panel id="sbreath" cls="c12" title="Breathing disturbances, every night" draw={drawBreathing} watch={W} foot={<><code>AppleSleepingBreathingDisturbances</code><code>SleepApneaEvent</code><span>One value per night from the watch; notifications cover 30-day windows</span></>} />
          <Panel id="swin" cls="c7" title="The 30-day windows" draw={drawBreathWindows} watch={W} foot={<span>The rule is fitted to your own notified and quiet windows (sleep.breathing in the pipeline); Apple does not publish its threshold</span>} />
          <Panel id="sfact" cls="c5" title="Which nights run higher" draw={drawBreathFactors} watch={W} />
        </div>
      </section>}
      <SleepRecords />
      <section className="chapter" id="ssources">
        <ChHead idx={14} eyebrow="Sources" title="Where each night came from">An export can hold sleep from another watch, sleep apps, the phone's bedtime schedule and the Apple Watch, often for the same night. Each night keeps one.</ChHead>
        <div className="grid">
          <Panel id="ssrc" cls="c12" title="Nights by source" draw={drawSleepSources} watch={W} foot={<><code>HKCategoryTypeIdentifierSleepAnalysis</code><span>Rules Z1–Z5 in docs/CLEANING.md; every change is in cleaning_log</span></>} />
        </div>
      </section>
    </main>
  );
}

function SleepHero() {
  const v = useWatch(['filter', 'sleep', 'milestones']);
  const N = nightsIn(), M = N.filter(measured);
  const med = d3.median(M, (n: any) => n.asleep) ?? 0;
  const a = useRef<HTMLSpanElement>(null), em = useRef<HTMLElement>(null);
  useLayoutEffect(() => { countTo(a.current, N.length, x => `${fInt(x)} nights`); countTo(em.current, med, x => `${f1(x)} hours a night`); }, [v]);
  const tiles = (() => {
    if (!M.length) return [];
    const on = d3.median(M, (n: any) => n.on), wake = d3.median(M, (n: any) => n.wake);
    const st = M.filter((n: any) => n.cls === 'stages'), tot = d3.sum(st, (n: any) => n.deep + n.core + n.rem);
    const q = (p: number) => d3.quantile(M.map((n: any) => n.on).sort(d3.ascending), p);
    const seven = M.filter((n: any) => n.asleep >= 7).length;
    return [
      { k: 'Nights measured', v: fInt(M.length), x: `of ${fInt(N.length)}; the rest are time in bed or estimates` },
      { k: 'Typical night', v: fDur(med * 60), x: `middle half ${f1(d3.quantile(M.map((n: any) => n.asleep).sort(d3.ascending), 0.25))}–${f1(d3.quantile(M.map((n: any) => n.asleep).sort(d3.ascending), 0.75))} h` },
      { k: 'Asleep by', v: fClock(on), x: `half of nights between ${fClock(q(0.25))} and ${fClock(q(0.75))}` },
      { k: 'Awake by', v: fClock(wake), x: `median wake time` },
      { k: '7 hours or more', v: `${Math.round(seven / M.length * 100)}%`, x: `${fInt(seven)} nights` },
      ...(st.length ? [{ k: 'Deep and REM', v: `${Math.round(d3.sum(st, (n: any) => n.deep + n.rem) / tot * 100)}%`, x: `of time asleep, ${fInt(st.length)} staged nights` }] : []),
    ];
  })();
  const t = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { armArrival(t.current); }, [v]);
  return (
    <section className="chapter" id="nights">
      <div className="hero">
        <div className="hero-head"><div>
          <div className="eyebrow">{N.length ? `Every night, ${fDate(N[0].d)} to ${fDate(N[N.length - 1].d)}` : 'No nights in range'}</div>
          <h1><span ref={a} />, <em ref={em} /></h1>
          <p>From every source that wrote sleep to Health, one per night: another watch, sleep apps, the phone's bedtime schedule and the Apple Watch. Stages from watchOS 9. Missing nights stay missing.</p>
        </div></div>
        <div className="grid"><Panel id="barcode" cls="c12" title="Every night" draw={drawBarcode} watch={W} /></div>
      </div>
      <div className="tiles" ref={t}>{tiles.map(x => <div className="tile a-fade" key={x.k}><span className="lbl">{x.k}</span><span className="v">{x.v}</span><span className="x">{x.x}</span></div>)}</div>
    </section>
  );
}

function NightSection() {
  const v = useWatch(['filter', 'sleep', 'night', 'theme', 'size']);
  const N = nightsIn();
  const recs = sleepRecords();
  if (!S.nightId || !G.sleep.nights.some((n: any) => n.iso === S.nightId)) S.nightId = (recs.find(r => r.label === 'Most deep sleep') || recs[0])?.n.iso ?? N[N.length - 1]?.iso;
  const n = G.sleep.nights.find((x: any) => x.iso === S.nightId);
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (el.current) drawHypno(el.current, n); }, [v]);
  const recent = N.slice(-30).reverse();
  return (
    <section className="chapter" id="onenight">
      <div className="ch-head">
        <div><div className="eyebrow">One night</div><h2>{n ? `Night of ${fDate(n.d)}` : 'One night'}</h2></div>
        <div className="cu-picker"><label className="lbl" htmlFor="nightSel" style={{ alignSelf: 'center' }}>Night</label>
          <select className="sel" id="nightSel" value={S.nightId ?? ''} onChange={e => { S.nightId = e.target.value; emit('night'); }}>
            <optgroup label="Records">{recs.map(r => <option key={'r' + r.label} value={r.n.iso}>{r.label}: {r.val}</option>)}</optgroup>
            <optgroup label="Most recent">{recent.map((x: any) => <option key={x.iso} value={x.iso}>{fDate(x.d)} · {x.asleep != null ? fDur(x.asleep * 60) : 'in bed only'}</option>)}</optgroup>
            {n && !recs.some(r => r.n.iso === n.iso) && !recent.some((x: any) => x.iso === n.iso) && <optgroup label="Selected"><option value={n.iso}>{fDate(n.d)}</option></optgroup>}
          </select></div>
        <p>The night as the watch recorded it, stage by stage. Pick any night in the picture above, or a record below.</p>
      </div>
      <div className="grid">
        <div className="panel c12" id="p-night">
          <div className="cu-stats">{nightStats(n).map(([k, val]) => <div key={k}><span className="lbl">{k}</span><span className="v">{val}</span></div>)}</div>
          <div className="chart" ref={el} />
          <div className="p-foot"><span>Source: {n?.source}{n?.nsrc > 1 ? ` (chosen from ${n.nsrc} sources that night)` : ''}{n?.est ? '. * An estimate: this source records almost no time awake.' : ''}{n?.away ? '. Away from home: times are local where you slept.' : ''}</span></div>
        </div>
      </div>
    </section>
  );
}

function SleepRecords() {
  const v = useWatch(['filter', 'sleep']);
  const recs = sleepRecords();
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { armArrival(el.current); }, [v]);
  const groups = d3.groups(recs, (r: any) => r.group);
  return (
    <section className="chapter" id="srecords">
      <ChHead idx={15} eyebrow="Records" title="Nights that stand out">Within the year filter, measured nights only (estimates are left out). Pick one to open it above.</ChHead>
      <div className="recs" ref={el}>
        {!recs.length && <div className="empty">No measured nights in range</div>}
        {groups.map(([g, list]: any) => (
          <Fragment key={g}>
            <div className="recs-group">{g}</div>
            {list.map((r: any) => (
              <button key={r.label} type="button" className="rec-card a-fade" data-rec={r.label} onClick={() => openNight(r.n)}>
                <span className="lbl">{r.label}</span><span className="v">{r.val}</span><span className="d">{r.det}</span><span className="go">Open the night →</span>
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
