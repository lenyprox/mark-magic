import { test, expect } from '@playwright/test';

// Creates a tiny optimiser run through the API (the detached daemon does the work), watches the run page until it
// finishes, checks the report renders, then deletes the run.
test('optimise: a small run finishes in the background and the page shows the report', async ({ page, request }) => {
  const decks = await (await request.get('/api/decks')).json() as { id: string; name: string; format: string }[];
  const imported: string[] = [];
  const mk = async (name: string, text: string) => { const r = await request.post('/api/decks/import', { data: { text, save: true, format: 'modern' } }); expect(r.status()).toBe(201); const { deck } = await r.json(); imported.push(deck.id); return deck as { id: string; name: string }; };
  const seed = await mk('E2E opt seed', '// E2E opt seed\n4 Lightning Bolt\n4 Monastery Swiftspear\n4 Goblin Guide\n4 Lava Spike\n4 Rift Bolt\n4 Shock\n18 Mountain');
  const opp = decks.find(d => d.name === 'Burn test') ?? await mk('E2E opt opp', '// E2E opt opp\n4 Grizzly Bears\n4 Hill Giant\n4 Giant Growth\n20 Forest');
  let runId: string | null = null;
  try {
    const res = await request.post('/api/optimizer/runs', { data: { deckId: seed.id, preset: 'quick', field: [{ kind: 'deck', deckId: opp.id, name: opp.name, weight: 1 }], players: 2, pool: 'owned', maxUnowned: 0, seed: 7, games: 60, iterations: 1, workers: 2 } });
    expect(res.status()).toBe(201);
    const { run } = await res.json();
    runId = run.id as string;
    await page.goto(`/optimize/${runId}`);
    await expect(page.getByTestId('optimize-run')).toBeVisible();
    // the daemon needs to boot tsx and play ~100 games
    await expect(page.getByTestId('optimize-report')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText(/Baseline/).first()).toBeVisible();
    await expect(page.getByText(/Swaps tried/)).toBeVisible();
    // the list page shows it as done
    await page.goto('/optimize');
    await expect(page.getByTestId('optimize-run-card').filter({ hasText: 'E2E opt seed' }).first()).toContainText(/done/);
    // the deck page links here
    await page.goto(`/decks/${seed.id}`);
    await expect(page.getByTestId('optimize-this-deck')).toBeVisible();
  } finally {
    if (runId) await request.delete(`/api/optimizer/runs/${runId}`);
    for (const id of imported) await request.delete(`/api/decks/${id}`);
  }
});
