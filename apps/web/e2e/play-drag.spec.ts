import { test, expect, type Locator, type Page } from '@playwright/test';

// Drag-and-drop on the play table: a land from hand onto the battlefield plays it, a second land snaps back with a
// rule toast, and a Lightning Bolt dropped on the battlefield parks in the casting slot until its target is dropped.

async function startGame(page: Page, seed = 42) {
  await page.goto('/play');
  await page.waitForSelector('[data-testid=play-my-deck] option[value="b.mono-red-burn"]', { state: 'attached', timeout: 60_000 });
  await page.selectOption('[data-testid=play-my-deck]', 'b.mono-red-burn');
  await page.selectOption('[data-testid=play-opp-deck]', 'b.mono-green-stompy');
  await page.fill('[data-testid=play-seed]', String(seed));
  await page.click('button[name=Deal]');
  await page.waitForSelector('[data-testid=decision-sheet], [data-testid=priority-bar][data-state=mine]', { timeout: 120_000 });
  const keep = page.getByRole('button', { name: /keep/i }).first();
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await waitForPriority(page);
}

async function waitForPriority(page: Page) {
  await expect(page.getByTestId('priority-bar')).toHaveAttribute('data-state', 'mine', { timeout: 90_000 });
}

/** Press on the left third of a card (the part no neighbour in the fan overlaps), then drag to a point. */
async function dragCard(page: Page, card: Locator, to: { x: number; y: number }) {
  const a = await card.boundingBox();
  if (!a) throw new Error('card has no box');
  const sx = a.x + a.width * 0.3; const sy = a.y + a.height * 0.5;
  await page.mouse.move(sx, sy);
  await page.waitForTimeout(350); // hover lift settles
  const b = await card.boundingBox();
  const px = b ? b.x + b.width * 0.3 : sx; const py = b ? b.y + b.height * 0.5 : sy;
  await page.mouse.move(px, py);
  await page.mouse.down();
  await page.mouse.move(px + 12, py - 12, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.waitForTimeout(60);
  await page.mouse.up();
}

async function centre(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('no box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const handCard = (page: Page, name: string) => page.getByTestId('hand').locator(`[data-card-name="${name}"]`);
const myLands = (page: Page) => page.getByTestId('battlefield-me').locator('[data-card-name="Mountain"]');

test('drag: a land from hand onto the battlefield plays it; a second one snaps back citing 305.2', async ({ page }) => {
  await startGame(page);
  await expect(handCard(page, 'Mountain').first()).toBeVisible();
  const before = await myLands(page).count();
  const bf = page.getByTestId('battlefield-me');
  await expect(bf).toBeVisible();

  const first = handCard(page, 'Mountain').last();
  await dragCard(page, first, await centre(bf));
  await expect(myLands(page)).toHaveCount(before + 1, { timeout: 30_000 });
  await waitForPriority(page);

  const second = handCard(page, 'Mountain').last();
  await expect(second).toBeVisible();
  const handBefore = await handCard(page, 'Mountain').count();
  await dragCard(page, second, await centre(bf));
  await expect(page.getByText(/305\.2/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('drag-ghost')).toHaveCount(0, { timeout: 5_000 }); // snapped back and settled
  await expect(handCard(page, 'Mountain')).toHaveCount(handBefore);
  await expect(myLands(page)).toHaveCount(before + 1);
});

test('drag: Lightning Bolt to the battlefield parks in the casting slot; dropping the tether on the opponent casts it', async ({ page }) => {
  test.setTimeout(240_000);
  // Seeds whose opening hand holds Lightning Bolt and a Mountain with the human on the play (probed offline with the
  // engine); the first that reproduces in the browser is used, so an engine shuffle change degrades to a skip.
  const castableBolt = () => handCard(page, 'Lightning Bolt').and(page.locator('[data-castable]'));
  let found = false;
  for (const seed of [17, 5, 20]) {
    await startGame(page, seed);
    const bf = page.getByTestId('battlefield-me');
    if (await handCard(page, 'Mountain').count()) {
      const before = await myLands(page).count();
      await dragCard(page, handCard(page, 'Mountain').last(), await centre(bf));
      await expect(myLands(page)).toHaveCount(before + 1, { timeout: 30_000 });
      await waitForPriority(page);
    }
    found = (await castableBolt().count()) > 0;
    if (found) break;
  }
  test.skip(!found, 'No seed produced a castable Lightning Bolt on turn 1');

  const bf = page.getByTestId('battlefield-me');
  await dragCard(page, castableBolt().first(), await centre(bf));
  const slot = page.getByTestId('casting-slot');
  await expect(slot).toBeVisible();
  await expect(slot).toHaveAttribute('data-card-name', 'Lightning Bolt');
  await expect(page.getByTestId('tether')).toBeVisible();
  await expect(page.getByTestId('targeting-bar')).toBeVisible();

  const plate = page.getByTestId('plate-opp');
  await expect(plate).toHaveAttribute('data-legal-target', '');
  await dragCard(page, slot.locator('[data-cast-slot]'), await centre(plate));
  await expect(page.getByTestId('stack').locator('[data-card-name="Lightning Bolt"]')).toBeVisible({ timeout: 30_000 });
  await expect(slot).toHaveCount(0);
});
