'use client';
// Hidden tuning page for the card renderer: the reference printings as always-live cards, shader / motion
// controls, and a 48-card hover-upgrading grid to exercise the shared-context path and scroll performance.
import { useEffect, useMemo, useState } from 'react';
import type { CardSummary } from '@cards/query';
import { Card3D, CardGLProvider, FinishToggle, useCardGL, useCardGLStats, type FinishName } from '@/components/card';
import { normalMapPipelineInfo } from '@/lib/gl/normalmap';
import { countNormalMaps } from '@/lib/gl/normalmap-cache';
import { deviceOrientationNeedsPermission } from '@/lib/gl/interaction';
import type { QualitySetting } from '@/lib/gl/support';
import styles from './page.module.css';

interface Ref { label: string; url: string; pick?: (items: CardSummary[]) => CardSummary | undefined }

const REFS: Ref[] = [
  { label: 'Scene: Cloud', url: '/api/cards?mode=printing&set=fic&q=n:"cloud, ex-soldier"&ps=20', pick: it => it.find(i => i.collectorNumber === '2') ?? it[0] },
  { label: '2015 rare', url: '/api/cards?mode=printing&set=dmu&q=n:"sheoldred, the apocalypse"&ps=10', pick: it => it.find(i => !i.frameEffects.includes('showcase') && i.borderColor !== 'borderless') ?? it[0] },
  { label: '1997 frame', url: '/api/cards?mode=printing&set=7ed&q=n:"llanowar elves"&ps=3' },
  { label: 'Etched foil', url: '/api/cards?mode=printing&set=cmr&r=mythic&ps=60', pick: it => it.find(i => i.finishes.includes('etched')) },
  { label: 'Showcase', url: '/api/cards?mode=printing&set=dmu&q=n:"sheoldred, the apocalypse"&ps=10', pick: it => it.find(i => i.frameEffects.includes('showcase')) },
  { label: 'Borderless', url: '/api/cards?mode=printing&set=znr&r=mythic&ps=100', pick: it => it.find(i => i.borderColor === 'borderless') },
  { label: 'Saga', url: '/api/cards?q=t:saga&ps=1' },
  { label: 'Split', url: '/api/cards?q=n:"fire // ice"&ps=1' },
  { label: 'Transform DFC', url: '/api/cards?q=n:"delver of secrets"&ps=3', pick: it => it.find(i => i.hasBack) },
  { label: 'Full-art basic', url: '/api/cards?mode=printing&set=znr&q=t:basic&ps=40', pick: it => it.find(i => i.fullArt) },
  { label: '1993 frame', url: '/api/cards?mode=printing&set=lea&q=n:"serra angel"&ps=1' },
  { label: 'Planeswalker', url: '/api/cards?mode=printing&set=dom&q=n:"teferi, hero of dominaria"&ps=3' },
];

type FinishChoice = 'auto' | FinishName;

export default function CardDevPage() {
  return (
    <CardGLProvider>
      <CardDev />
    </CardGLProvider>
  );
}

function CardDev() {
  const gl = useCardGL()!;
  const stats = useCardGLStats();
  const [refs, setRefs] = useState<{ label: string; card: CardSummary }[]>([]);
  const [grid, setGrid] = useState<CardSummary[]>([]);
  const [finish, setFinish] = useState<FinishChoice>('auto');
  const [motion, setMotion] = useState<'auto' | 'full' | 'reduced'>('auto');
  const [size, setSize] = useState<'normal' | 'large'>('normal');
  const [live, setLive] = useState<'always' | 'hover'>('always');
  const [tapped, setTapped] = useState(false);
  const [layer, setLayer] = useState<'base' | 'overlay'>('base');
  const [logFrames, setLogFrames] = useState(false);
  const [cacheCount, setCacheCount] = useState<number | null>(null);
  const [pipeline, setPipeline] = useState(() => normalMapPipelineInfo());
  const [orientation, setOrientation] = useState<'off' | 'on' | 'denied'>('off');
  const [cloudScene, setCloudScene] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: { label: string; card: CardSummary }[] = [];
      for (const r of REFS) {
        try {
          const res = await fetch(r.url);
          const json = (await res.json()) as { items: CardSummary[] };
          const card = r.pick ? r.pick(json.items) : json.items[0];
          if (card) out.push({ label: r.label, card });
        } catch { /* skip */ }
      }
      if (!cancelled) setRefs(out);
      try {
        const res = await fetch('/api/cards?r=rare,mythic&sort=edhrec&ps=48');
        const json = (await res.json()) as { items: CardSummary[] };
        if (!cancelled) setGrid(json.items);
      } catch { /* skip */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => { setPipeline(normalMapPipelineInfo()); void countNormalMaps().then(setCacheCount); }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => gl.subscribeStats(s => { (window as unknown as { __cardgl?: unknown }).__cardgl = s; }), [gl]);

  useEffect(() => {
    if (!logFrames) return;
    return gl.subscribeStats(s => console.log(`[CardGL] ${s.running ? 'running' : 'idle'} fps=${s.fps.toFixed(0)} frame=${s.frameMs.toFixed(2)}ms avg=${s.avgFrameMs.toFixed(2)}ms draws=${s.draws} live=${s.live} q=${s.quality} dpr=${s.dpr}`));
  }, [logFrames, gl]);

  const finishFor = (c: CardSummary): FinishName | undefined => finish === 'auto' ? undefined : finish;
  const t = gl.tuning;
  const slider = (label: string, key: keyof typeof t, min: number, max: number, step = 0.05) => (
    <label className={styles.control}>
      <span>{label} <code>{t[key].toFixed(2)}</code></span>
      <input type="range" min={min} max={max} step={step} value={t[key]} onChange={e => gl.setTuning({ [key]: Number(e.target.value) })} />
    </label>
  );

  const gridCards = useMemo(() => grid.map(c => (
    <div key={c.printingId} className={styles.cell}>
      <Card3D printing={c} finish={finishFor(c)} live="hover" motion={motion} tilt="default" />
    </div>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  )), [grid, finish, motion]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Card renderer</h1>
          <p className={styles.sub}>Reference printings are always live; the grid below upgrades on hover. WebGL2: {gl.supported == null ? '…' : gl.supported ? 'yes' : 'no (CSS fallback)'}</p>
        </div>
        <dl className={styles.stats} aria-live="off">
          <div><dt>fps</dt><dd>{stats ? stats.fps.toFixed(0) : '–'}</dd></div>
          <div><dt>frame</dt><dd>{stats ? `${stats.frameMs.toFixed(2)} ms` : '–'}</dd></div>
          <div><dt>avg</dt><dd>{stats ? `${stats.avgFrameMs.toFixed(2)} ms` : '–'}</dd></div>
          <div><dt>draws</dt><dd>{stats?.draws ?? '–'}</dd></div>
          <div><dt>live</dt><dd>{stats?.live ?? '–'}</dd></div>
          <div><dt>loop</dt><dd className={stats?.running ? styles.on : styles.off}>{stats ? (stats.running ? 'running' : 'idle') : '–'}</dd></div>
          <div><dt>quality</dt><dd>{stats?.quality ?? '–'} @{stats?.dpr ?? '–'}x</dd></div>
          <div><dt>nmaps</dt><dd>{pipeline.mode} q{pipeline.queued} r{pipeline.inflight} · idb {cacheCount ?? '–'}</dd></div>
          <div><dt>scene</dt><dd>{stats ? `${stats.sceneCards} · ${stats.sceneMs.toFixed(2)} ms` : '–'}</dd></div>
        </dl>
      </header>

      <section className={styles.controls} aria-label="Tuning">
        <div className={styles.control}>
          <span>Finish</span>
          <div className={styles.row}>
            <button type="button" className={finish === 'auto' ? styles.active : undefined} onClick={() => setFinish('auto')} aria-pressed={finish === 'auto'}>Auto</button>
            <FinishToggle showAll value={finish === 'auto' ? 'nonfoil' : finish} onChange={setFinish} size="sm" />
          </div>
        </div>
        <div className={styles.control}>
          <span>Quality</span>
          <div className={styles.row}>
            {(['auto', 'high', 'medium'] as QualitySetting[]).map(q => <button key={q} type="button" className={gl.quality === q ? styles.active : undefined} aria-pressed={gl.quality === q} onClick={() => gl.setQuality(q)}>{q}</button>)}
          </div>
        </div>
        <div className={styles.control}>
          <span>Motion</span>
          <div className={styles.row}>
            {(['auto', 'full', 'reduced'] as const).map(m => <button key={m} type="button" className={motion === m ? styles.active : undefined} aria-pressed={motion === m} onClick={() => setMotion(m)}>{m}</button>)}
          </div>
        </div>
        <div className={styles.control}>
          <span>References</span>
          <div className={styles.row}>
            {(['normal', 'large'] as const).map(s => <button key={s} type="button" className={size === s ? styles.active : undefined} aria-pressed={size === s} onClick={() => setSize(s)}>{s}</button>)}
            {(['always', 'hover'] as const).map(l => <button key={l} type="button" className={live === l ? styles.active : undefined} aria-pressed={live === l} onClick={() => setLive(l)}>{l}</button>)}
            <button type="button" className={tapped ? styles.active : undefined} aria-pressed={tapped} onClick={() => setTapped(v => !v)}>tapped</button>
            <button type="button" className={layer === 'overlay' ? styles.active : undefined} aria-pressed={layer === 'overlay'} onClick={() => setLayer(l => (l === 'base' ? 'overlay' : 'base'))}>overlay layer</button>
          </div>
        </div>
        {slider('Relief', 'relief', 0, 2.5)}
        {slider('Foil strength', 'foil', 0, 2)}
        {slider('Tilt scale', 'tiltScale', 0, 2)}
        {slider('Glare', 'glare', 0, 2)}
        {slider('Corner radius', 'radius', 0.02, 0.08, 0.002)}
        {slider('Scene mix', 'sceneMix', 0, 1)}
        {slider('Parallax', 'parallax', 0, 1.5)}
        {slider('Rays', 'rays', 0, 3)}
        {slider('Glow', 'glow', 0, 3)}
        {slider('Metal', 'metal', 0, 3)}
        {slider('Ambient motion', 'ambient', 0, 2)}
        {slider('Flow speed', 'flowSpeed', 0, 3)}
        {slider('Embers', 'embers', 0, 2)}
        {slider('Heat haze', 'haze', 0, 3)}
        {slider('Exposure', 'exposure', 0.4, 2)}
        <div className={styles.control}>
          <span>Scene view</span>
          <div className={styles.row}>
            {(['lit', 'depth', 'matte', 'bg', 'material', 'fx', 'flow', 'rays', 'albedo', 'solid'] as const).map((name, i) => <button key={name} type="button" className={t.sceneDebug === i ? styles.active : undefined} aria-pressed={t.sceneDebug === i} onClick={() => gl.setTuning({ sceneDebug: i })}>{name}</button>)}
          </div>
        </div>
        <div className={styles.control}>
          <span>Diagnostics</span>
          <div className={styles.row}>
            <button type="button" className={logFrames ? styles.active : undefined} aria-pressed={logFrames} onClick={() => setLogFrames(v => !v)}>log frame times</button>
            <button type="button" className={orientation === 'on' ? styles.active : undefined} onClick={async () => setOrientation((await gl.enableDeviceOrientation()) ? 'on' : 'denied')}>
              device tilt{deviceOrientationNeedsPermission() ? ' (permission)' : ''}{orientation === 'denied' ? ': unavailable' : ''}
            </button>
          </div>
        </div>
      </section>

      <section aria-label="Reference printings">
        <h2 className={styles.h2}>Reference printings</h2>
        <div className={styles.refs}>
          {refs.map(({ label, card }) => (
            <figure key={card.printingId} className={styles.ref}>
              <Card3D printing={card} finish={finishFor(card)} live={live} size={size} motion={motion} tilt={size === 'large' ? 'hero' : 'default'} tapped={tapped} layer={layer} priority scene={label === 'Scene: Cloud' && cloudScene} />
              <figcaption>
                <strong>{label}</strong>
                {label === 'Scene: Cloud' && (
                  <button type="button" className={cloudScene ? styles.active : undefined} aria-pressed={cloudScene} onClick={() => setCloudScene(v => !v)}>{cloudScene ? '2.5D scene: on' : '2.5D scene: off'}</button>
                )}
                <span>{card.name}</span>
                <span className={styles.meta}>{card.setCode.toUpperCase()} · {card.frame ?? '?'} · {card.layout}{card.frameEffects.length ? ` · ${card.frameEffects.join(', ')}` : ''}{card.fullArt ? ' · full art' : ''} · {card.finishes.join('/')}</span>
              </figcaption>
            </figure>
          ))}
          {!refs.length && <p className={styles.sub}>Loading reference printings…</p>}
        </div>
      </section>

      <section aria-label="Hover grid">
        <h2 className={styles.h2}>Hover-upgrade grid ({grid.length})</h2>
        <div className={styles.grid}>{gridCards}</div>
      </section>
    </main>
  );
}
