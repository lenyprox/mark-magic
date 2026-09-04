// /coverage: the verification dashboard — parser coverage by type, scripts, the pool sandbox, scenarios and rules
// cited, metagame coverage, benchmark. Data comes from data/master/verification.json (npm run verify:dashboard).
import styles from './coverage.module.css';

export interface Verification {
  generated_at: string;
  parser: { playable: number; fully_parsed: number; pct: number; by_type: Record<string, { total: number; full: number; pct: number }>; top_unparsed: { n: number; clause: string }[]; keyword_bailouts: { n: number; clause: string }[]; generated_at: string } | null;
  scripts: { total: number; stale: number; fully_parsed_via_script: number };
  sandbox: { cards: number; counts: Record<string, number>; top_problems: { n: number; detail: string; cards: string[] }[]; generated_at: string } | null;
  scenarios: { total: number; files: Record<string, number>; rules_cited: string[] };
  meta: Record<string, unknown> | null;
  bench: { at: string; results: { name: string; games: number; gamesPerSecond: number; avgTurns: number; draws: number; errors: number; unsimulated: number }[] } | null;
}

const pct = (x: number) => `${x.toFixed(1)}%`;

export function CoveragePage({ data }: { data: Verification | null }) {
  if (!data) return <div className={styles.page}><h1>Coverage</h1><p className="faint">No dashboard data yet. Run <code>npm run coverage:pool && npm run verify:pool && npm run verify:dashboard</code>.</p></div>;
  const p = data.parser; const sb = data.sandbox;
  const sbTotal = sb ? Object.values(sb.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className={styles.page} data-testid="coverage-page">
      <div className={styles.head}><h1>Coverage</h1><span className="faint small">generated {new Date(data.generated_at).toLocaleString()}</span></div>
      <p className="faint">How much of Magic the engine simulates faithfully, and how that claim is checked: parser coverage of the playable pool, per-card scripts, a sandbox that plays every parsed card, behavioural scenarios that cite the Comprehensive Rules, and the games-per-second budget.</p>
      <div className={styles.stats}>
        <Stat label="Pool fully simulated" value={p ? pct(p.pct) : '–'} note={p ? `${p.fully_parsed.toLocaleString()} of ${p.playable.toLocaleString()} playable cards` : ''} />
        <Stat label="Card scripts" value={String(data.scripts.total)} note={`${data.scripts.fully_parsed_via_script} complete via script · ${data.scripts.stale} stale`} />
        <Stat label="Sandbox" value={sb ? pct(100 * (sb.counts['sandbox-ok'] ?? 0) / Math.max(1, sbTotal)) : '–'} note={sb ? `${sb.counts['sandbox-ok'] ?? 0} ok · ${sb.counts['unreachable'] ?? 0} unreachable · ${(sb.counts['sandbox-throws'] ?? 0) + (sb.counts['invariant-violation'] ?? 0)} failing` : ''} />
        <Stat label="Scenarios" value={String(data.scenarios.total)} note={`${data.scenarios.rules_cited.length} rules cited`} />
        <Stat label="Speed" value={data.bench ? `${data.bench.results[0]?.gamesPerSecond.toFixed(0)} games/s` : '–'} note={data.bench ? data.bench.results.map(r => `${r.name} ${r.gamesPerSecond.toFixed(1)}/s`).join(' · ') : ''} />
      </div>

      {p && (
        <section className={styles.section}>
          <div className={styles.sectionHead}><h2>Parser coverage by card type</h2></div>
          <table className={styles.table}><thead><tr><th>Type</th><th>Cards</th><th>Fully simulated</th><th /></tr></thead>
            <tbody>{Object.entries(p.by_type).sort((a, b) => b[1].total - a[1].total).map(([t, v]) => <tr key={t}><td>{t}</td><td className={styles.num}>{v.total.toLocaleString()}</td><td className={styles.num}>{v.full.toLocaleString()} ({pct(v.pct)})</td><td className={styles.barCell}><div className={styles.bar}><div className={styles.barFill} style={{ width: `${v.pct}%` }} /></div></td></tr>)}</tbody></table>
        </section>
      )}

      <div className={styles.grid2}>
        {p && (
          <section className={styles.section}>
            <div className={styles.sectionHead}><h2>Most common unparsed clauses</h2><span className="faint small">what to teach the parser next</span></div>
            <ol className={styles.clauses}>{p.top_unparsed.slice(0, 30).map((c, i) => <li key={i}><span className={styles.num}>{c.n}</span> <code>{c.clause}</code></li>)}</ol>
          </section>
        )}
        <section className={styles.section}>
          <div className={styles.sectionHead}><h2>Scenarios and rules</h2></div>
          <p className="small">{Object.entries(data.scenarios.files).map(([f, n]) => `${f}: ${n}`).join(' · ')}</p>
          <div className={styles.rules}>{data.scenarios.rules_cited.map(r => <span key={r} className={styles.rule}>CR {r}</span>)}</div>
          {sb && sb.top_problems.length > 0 && (
            <>
              <div className={styles.sectionHead}><h2>Sandbox failures</h2></div>
              <ul className={styles.clauses}>{sb.top_problems.map((x, i) => <li key={i}><span className={styles.num}>{x.n}</span> {x.detail} <span className="faint">({x.cards.join(', ')})</span></li>)}</ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className={styles.stat}><div className={styles.statLabel}>{label}</div><div className={styles.statValue}>{value}</div>{note && <div className={styles.statNote}>{note}</div>}</div>;
}
