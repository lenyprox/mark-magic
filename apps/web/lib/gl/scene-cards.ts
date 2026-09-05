// Printings that offer the optional 2.5D scene (see scene.ts). The scene is an opt-in per card: the print's
// relief rendering stays the default look, and only these printings show the toggle in the UI.
export const SCENE_PRINTINGS: ReadonlySet<string> = new Set([
  '07b4e4f8-6a31-4533-be51-668ce3ddc84f',   // Cloud, Ex-SOLDIER (FIC #2), the reference card
]);

export function hasSceneToggle(printingId: string | null | undefined): boolean {
  return !!printingId && SCENE_PRINTINGS.has(printingId);
}
