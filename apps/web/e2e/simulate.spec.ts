import { test, expect } from '@playwright/test';

// Imports a small deck, runs 50 games against a bundled deck in the batch workers and checks the result table,
// then replays the batch and expects the seeded rerun to be identical.
test('deck page: simulate 50 games against a bundled deck and verify the replay', async ({ page, request }) => {
  const res = await request.post('/api/decks/import', { data: { text: '// E2E sim deck\n4 Lightning Bolt\n4 Monastery Swiftspear\n4 Goblin Guide\n4 Lava Spike\n4 Rift Bolt\n20 Mountain', save: true, format: 'modern' } });
  expect(res.status()).toBe(201);
  const { deck } = await res.json();
  try {
    await page.goto(`/decks/${deck.id}`);
    const section = page.getByTestId('simulate-section');
    await expect(section).toBeVisible();
    await section.getByTestId('simulate-opponent').selectOption({ label: 'mono-green-stompy (bundled)' });
    await section.getByRole('radio', { name: '50', exact: true }).click();
    await section.getByTestId('simulate-run').click();
    await expect(section.getByTestId('simulate-results')).toBeVisible({ timeout: 60_000 });
    await expect(section.getByTestId('simulate-replay')).toBeVisible({ timeout: 90_000 });
    await expect(section.getByText(/^50 games/)).toBeVisible();
    const win = await section.getByTestId('simulate-win-0').textContent();
    expect(win).toMatch(/^\d+\.\d%$/);
    await section.getByTestId('simulate-replay').click();
    await expect(section.getByTestId('simulate-verify')).toContainText(/identical/, { timeout: 90_000 });
  } finally {
    await request.delete(`/api/decks/${deck.id}`);
  }
});
