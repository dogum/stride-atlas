import { useEffect, useState } from 'react';
import { G, MODE, S, computeF, emit, useWatch } from './store';
import { loadCore, loadRest, loadRoutes } from './data';
import { Header } from './components/header';
import { ChHead, Panel, Seg } from './components/ui';
import { AtlasSection, About, CloseupSection, RecordsSection, RelabelPanel, TrackPanel } from './components/sections';
import { CAL_METRICS, calRamp, drawCal, drawClock, drawDow, drawMatrix, drawPunch, drawSun } from './charts/rhythm';
import { drawMix, drawRace, drawWeekly, drawYearly } from './charts/volume';
import { EFF, EFFORT_TYPES, drawBpm, drawFit, drawGait, drawHrpace, drawPace, drawPhour, drawPtemp, drawWxYear, drawZones, effortList, paceRampCSS } from './charts/effort';
import { drawClimb, drawCond, drawFill, drawHills, drawWx } from './charts/terrain';
import { BE, BS, LOOPS, availableDists, drawBestTable, drawEdd, drawFF, drawGround, drawLoops, drawProg } from './charts/bests';
import { drawLift, drawRides, drawSensors, drawSwim, drawSwolf } from './charts/misc';
import { RINGS, ST, drawStreets } from './charts/streets';
import { drawDedupe, drawRules } from './charts/health';
import { PRESENT, Presenter } from './present';

function Loading({ msg, done }: { msg: string; done: boolean }) {
  return <div className="loading" style={{ opacity: done ? 0 : 1, pointerEvents: done ? 'none' : 'auto' }}><div><div>{msg}</div><div className="bar-l"><i /></div></div></div>;
}

function CalTools() {
  useWatch(['cal']);
  return <Seg label="Calendar metric" options={CAL_METRICS} value={S.calMetric} onPick={k => { S.calMetric = k; emit('cal'); }} />;
}
function CalFoot() {
  useWatch(['theme', 'data']);
  return <><span>Source</span><code>StepCount</code><code>DistanceWalkingRunning</code><code>FlightsClimbed</code><code>AppleExerciseTime</code><span>Phone and watch deduplicated per minute</span>
    <span className="ramp" style={{ marginLeft: 'auto' }}><span>less</span><span className="bar-r" style={{ background: `linear-gradient(90deg, ${calRamp().join(',')})` }} /><span>more</span></span></>;
}
function EffortSeg() {
  useWatch(['filter', 'effort']);
  return <Seg label="Activity for this chapter" options={EFFORT_TYPES.map(o => ({ ...o, disabled: !S.types.has(o.key) }))} value={S.effortType} onPick={k => { S.effortType = k; emit('effort'); }} />;
}
function PtempSeg() {
  useWatch(['ptemp']);
  return <Seg label="Raw or adjusted" options={[{ key: 'raw', label: 'Raw' }, { key: 'adjusted', label: 'Adjusted' }]} value={EFF.ptempMode} onPick={k => { EFF.ptempMode = k; emit('ptemp'); }} />;
}
function LoopsSeg() {
  useWatch(['loops']);
  return <Seg label="Lap times" options={[{ key: 'raw', label: 'Raw' }, { key: 'adjusted', label: 'Weather-adjusted' }]} value={LOOPS.mode} onPick={k => { LOOPS.mode = k; emit('loops'); }} />;
}
function StreetsCredit() { useWatch(['streets']); return <span>{G.streets?.attribution ?? '© OpenStreetMap contributors (ODbL)'}.</span>; }
function RingSeg() {
  useWatch(['streets']);
  return <Seg label="Distance from home" options={RINGS} value={ST.ring} onPick={k => { ST.ring = k; emit('streets'); }} />;
}
function PaceRamp() { useWatch(['theme']); return <span className="ramp"><span>20°F</span><span className="bar-r" style={{ background: paceRampCSS() }} /><span>95°F</span></span>; }
function ProgTools() {
  useWatch(['filter', 'prog', 'data']);
  const types = ['walk', 'run'].filter(t => S.types.has(t));
  if (types.length && !types.includes(BS.type)) BS.type = types[0];
  const dists = availableDists(BS.type);
  if (dists.length && !dists.includes(BS.dist)) BS.dist = dists[0];
  return <>
    <Seg label="Activity" options={[{ key: 'walk', label: 'Walks', disabled: !S.types.has('walk') }, { key: 'run', label: 'Runs', disabled: !S.types.has('run') }]} value={BS.type} onPick={k => { BS.type = k; emit('prog'); }} />
    <Seg label="Distance" options={BE[BS.type].map(l => ({ key: l, label: l, disabled: !dists.includes(l) }))} value={BS.dist} onPick={k => { BS.dist = k; emit('prog'); }} />
  </>;
}

export function App() {
  const [msg, setMsg] = useState('Reading your workouts');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        await loadCore(setMsg);
        G.workoutsByD = new Map<number, any[]>(); for (const w of G.workouts) { const a = G.workoutsByD.get(w.d) || []; a.push(w); G.workoutsByD.set(w.d, a); }
        computeF();
        setReady(true);
        emit('filter', 'data');
        requestAnimationFrame(() => performance.mark('stride-first-paint'));
        await loadRest(); computeF(); emit('data');
        await loadRoutes(); emit('routes');
        document.documentElement.dataset.loaded = 'all'; // scripts/shoot.mjs waits for this
      } catch (e: any) { console.error(e); setMsg('Could not read app/public/data. Run make all first. ' + (e?.message || '')); }
    })();
  }, []);
  // keep F in sync before any panel draws
  useWatch(['filter']);
  if (ready) computeF();
  useEffect(() => {
    let lastW = 0, t: any;
    const ro = new ResizeObserver(() => { const w = document.querySelector('main')?.clientWidth || 0; if (Math.abs(w - lastW) < 8) return; lastW = w; clearTimeout(t); t = setTimeout(() => { MODE.quiet = true; emit('size'); requestAnimationFrame(() => { MODE.quiet = false; }); }, 180); });
    const m = document.querySelector('main'); if (m) ro.observe(m);
    const mq = matchMedia('(prefers-color-scheme: dark)'); const onScheme = () => { MODE.quiet = true; emit('theme'); requestAnimationFrame(() => { MODE.quiet = false; }); };
    mq.addEventListener('change', onScheme);
    return () => { ro.disconnect(); mq.removeEventListener('change', onScheme); };
  }, [ready]);
  useWatch(['share']);
  useEffect(() => { document.body.classList.toggle('share-on', !!S.share); });

  if (!ready) return <Loading msg={msg} done={false} />;
  const E = ['effort'];
  return (
    <>
      <div className="tip" id="tip" role="status" aria-live="polite" />
      <Header />
      {PRESENT && <Presenter />}
      <main>
        <AtlasSection />

        <section className="chapter" id="rhythm">
          <ChHead idx={0} eyebrow="Rhythm" title="When you move">The same data cut by day, hour, weekday, month and year. Each view answers a different question about habit.</ChHead>
          <div className="grid">
            <Panel id="cal" cls="c12" title={`Every day since January ${G.Y0}`} draw={drawCal} watch={['cal']} tools={<CalTools />} foot={<CalFoot />} />
            <Panel id="sun" cls="c8" title="Every walk against the sun" draw={drawSun} foot={<span>Sunrise and sunset computed locally (astral) for each date at the route's start, in the time zone where you walked</span>} />
            <Panel id="clock" cls="c4" title="Your walking clock, year by year" draw={drawClock} foot={<span>Rings run {S.y0} (inner) to {S.y1} (outer); shade is that year's share of starts in each half hour, local time</span>} />
            <Panel id="punch" cls="c5" title="Hour of day by day of week" draw={drawPunch} />
            <Panel id="matrix" cls="c7" title="Average daily steps, month by year" draw={drawMatrix} />
            <Panel id="dow" cls="c12" title="Weekday profile" draw={drawDow} />
          </div>
        </section>

        <section className="chapter" id="volume">
          <ChHead idx={1} eyebrow="Volume" title="How much ground">Mileage by year, by week and by activity, with this year raced against every year before it.</ChHead>
          <div className="grid">
            <Panel id="race" cls="c7" title="Cumulative miles, year against year" draw={drawRace} />
            <Panel id="yearly" cls="c5" title="Miles per year by activity" draw={drawYearly} />
            <Panel id="weekly" cls="c12" title="Weekly miles, all time" draw={drawWeekly} />
            <Panel id="mix" cls="c12" title="Hours per month by activity" draw={drawMix} />
          </div>
        </section>

        <section className="chapter" id="effort">
          <ChHead idx={2} eyebrow="Pace & effort" title="How fast, and how hard" tools={<EffortSeg />}>Pace, heart rate and fitness over the years, set against temperature and time of day. Pick the activity for this chapter on the right.</ChHead>
          <div className="grid">
            <Panel id="pace" cls="c12" title="Pace of every workout" draw={drawPace} watch={E} extraHead={<PaceRamp />} foot={<span>Moving pace from the cleaned track. Line is the rolling median of 60 workouts. Dot color is the temperature at the start.</span>} />
            <Panel id="ptemp" cls="c6" title="Pace against temperature" draw={drawPtemp} watch={[...E, 'ptemp']} tools={<PtempSeg />} />
            <Panel id="phour" cls="c6" title="Pace by hour of day" draw={drawPhour} watch={E} />
            <Panel id="hrpace" cls="c7" title="Heart rate at the same pace" draw={drawHrpace} watch={E} />
            <Panel id="bpm" cls="c5" title="Heartbeats per mile" draw={drawBpm} watch={E} />
            <Panel id="zones" cls="c6" title="Time in heart-rate zones" draw={drawZones} watch={E} />
            <Panel id="fit" cls="c6" title="Resting heart rate and cardio fitness" draw={drawFit} foot={<><code>RestingHeartRate</code><code>VO2Max</code><span>Monthly mean with the 10th to 90th percentile band; gaps are months with no reading</span></>} />
            <Panel id="wxyear" cls="c5" title="Walking pace by year, weather removed" draw={drawWxYear} foot={<span>Same regression as the adjusted temperature view, evaluated at 60°F for each year</span>} />
            <Panel id="gait" cls="c7" title="Everyday walking, measured by your phone" draw={drawGait} foot={<><code>WalkingSpeed</code><code>WalkingStepLength</code><code>WalkingDoubleSupportPercentage</code><span>iPhone mobility metrics, from iOS 14</span></>} />
          </div>
        </section>

        <section className="chapter" id="terrain">
          <ChHead idx={3} eyebrow="Terrain & weather" title="Hills, heat and rain">What the ground and the sky were doing on every outing, including the gaps the export leaves and how free APIs fill them.</ChHead>
          <div className="grid">
            <Panel id="wx" cls="c8" title="Temperature at the start of every outing" draw={drawWx} />
            <Panel id="cond" cls="c4" title="Sky conditions by year" draw={drawCond} />
            <Panel id="climb" cls="c6" title="Feet climbed per year" draw={drawClimb} />
            <Panel id="hills" cls="c6" title="How hilly your routes are" draw={drawHills} />
            <Panel id="fill" cls="c12" title="What the export has, and what we fill in" draw={drawFill} foot={<><span>Weather gaps</span><code>NOAA GHCNh stations</code><code>archive-api.open-meteo.com/v1/archive</code><span>Elevation</span><code>USGS 3DEP 1/3 arc-second tiles</code><span>Both free, no key, cached on disk</span></>} />
          </div>
        </section>

        <section className="chapter" id="records">
          <ChHead idx={4} eyebrow="Records" title="Personal bests">Within the current filter. Pick any record with a route to open it in the close-up below.</ChHead>
          <RecordsSection />
        </section>

        <section className="chapter" id="bests">
          <ChHead idx={5} eyebrow="Bests" title="Getting better at the same things">Best efforts inside every workout, your favorite loops raced against themselves, and the slow curves of fitness and new ground.</ChHead>
          <div className="grid">
            <Panel id="prog" cls="c8" title="Best-effort progression" draw={drawProg} watch={['prog']} tools={<ProgTools />} foot={<span>Fastest stretch of the chosen distance inside any single workout, found with a two-pointer sliding window over the cleaned GPS track</span>} />
            <Panel id="bestTable" cls="c4" title="Current best efforts" draw={drawBestTable} watch={['prog']} />
            <Panel id="loops" cls="c12" title="Your loops, raced against themselves" draw={drawLoops} watch={['routes', 'share', 'loops']} tools={<LoopsSeg />} foot={<span>Loops are found by clustering routes that share at least 85% of their ground on a 25 m grid, start within 150 m and match in length within 5%</span>} />
            <Panel id="ff" cls="c8" title="Fitness, fatigue and form" draw={drawFF} foot={<span>Banister impulse-response model on daily TRIMP from heart rate. Fitness is a 42-day average, fatigue a 7-day average, form the difference.</span>} />
            <Panel id="edd" cls="c4" title="Eddington number" draw={drawEdd} />
            <Panel id="ground" cls="c12" title="New ground" draw={drawGround} foot={<span>Distinct path covered on foot, in date order: each route adds its distance times the share of its 30 m grid cells never visited before, so repeat walks add nothing</span>} />
            <Panel id="streets" cls="c12" title="Streets you have walked near home" draw={drawStreets} watch={['streets', 'share']} tools={<RingSeg />}
              foot={<><StreetsCredit /><span>A street segment counts once 60% of its length lies within 20 m of your walks, runs and hikes (15 m for paths). Driveways, parking aisles and sidewalks are left out; walking the sidewalk counts for its street.</span></>} />
          </div>
        </section>

        <CloseupSection />

        <section className="chapter" id="pool">
          <ChHead idx={6} eyebrow="Pool & weights" title="The workouts without a map">Pool swims, strength sessions and the indoor-ride years get their own views. Swims carry laps, strokes and SWOLF; the rest carry duration and heart rate.</ChHead>
          <div className="grid">
            <Panel id="swim" cls="c6" title="Yards swum per month" draw={drawSwim} />
            <Panel id="swolf" cls="c6" title="SWOLF, lower is better" draw={drawSwolf} />
            <Panel id="lift" cls="c12" title="Strength sessions per week" draw={drawLift} />
            <Panel id="rides" cls="c12" title="Indoor rides per month" draw={drawRides} />
          </div>
        </section>

        <section className="chapter" id="health">
          <ChHead idx={7} eyebrow="Data health" title="Clean before clever">What the pipeline fixes before any chart sees the data, and proof that it did. Regenerated on every run from cleaning_log.</ChHead>
          <div className="grid">
            <Panel id="rules" cls="c5" title="Cleaning rules and how often they fired" draw={drawRules} />
            <TrackPanel />
            <Panel id="dedupe" cls="c12" title="Why step totals need deduplicating" draw={drawDedupe} foot={<><code>HKQuantityTypeIdentifierStepCount</code><span>Both devices write overlapping samples. The Health app shows one total by preferring the watch, then filling gaps from the phone. The pipeline does the same, minute by minute.</span></>} />
            <RelabelPanel />
          </div>
        </section>

        <section className="chapter" id="watches">
          <ChHead idx={8} eyebrow="Watches" title="What each device could record">Each new watch, phone and OS version added sensors. Charts know when a metric didn't exist yet, so a missing value isn't read as a zero.</ChHead>
          <div className="grid">
            <Panel id="sensors" cls="c12" title="Devices and metrics over time" draw={drawSensors} chartClass="diagram-wrap" />
          </div>
        </section>

        <About />
      </main>
      <footer className="foot">Stride Atlas. Built locally from your Apple Health export ({G.meta?.export_date?.slice(0, 10)}); nothing on this page left your Mac. Missing values are shown as missing, never as zero.</footer>
      <Loading msg={msg} done />
    </>
  );
}
void effortList;
