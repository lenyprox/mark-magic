import { test, expect } from '@playwright/test';

// Imports one small CSV as its own source, checks the owned surfaces, then removes the source again.
test('collection: import a CSV, see owned badges everywhere, remove the source', async ({ page, request }) => {
  const csv = '2,Lightning Bolt\n1,"Betor, Kin to All"\n';
  const res = await request.post('/api/collection/import', { data: { files: [{ name: 'e2e-collection.csv', text: csv }], asDecks: false } });
  expect(res.status()).toBe(201);
  const body = await res.json();
  const source = body.results[0].source;
  expect(body.results[0].unresolved).toEqual([]);
  try {
    // owned filter narrows the browse grid and the tag shows the count
    await page.goto('/cards?own=1&q=lightning+bolt');
    await expect(page.locator('[role="gridcell"]').first()).toContainText(/Lightning Bolt/i);
    // other sources may already hold copies, so only the lower bound is fixed
    const tag = page.getByTestId('owned-tag').first();
    await expect(tag).toHaveText(/×\d+/);
    expect(Number((await tag.textContent())!.replace('×', ''))).toBeGreaterThanOrEqual(2);
    // the collection page lists the source and the card
    await page.goto('/collection');
    await expect(page.getByTestId('collection-page')).toBeVisible();
    await expect(page.getByText('e2e-collection.csv').first()).toBeVisible();
    await expect(page.getByTestId('collection-row-item').filter({ hasText: 'Lightning Bolt' })).toBeVisible();
    // the card page shows the collection row
    const ac = await (await request.get('/api/autocomplete?q=lightning+bo')).json();
    expect(ac[0].owned).toBeGreaterThanOrEqual(2);
    await page.goto(`/cards/${ac[0].oracleId}`);
    await expect(page.getByTestId('collection-row')).toContainText(/Owned/);
  } finally {
    const del = await request.delete(`/api/collection/sources/${source.id}`);
    expect(del.ok()).toBeTruthy();
  }
});
