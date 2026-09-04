'use client';
// Table settings in a drawer: sound (placeholder), playback speed, reduced motion, the explain default, when the
// pay tray asks, the WebGL quality and the tutorial. Persisted in localStorage (`vault.play.settings`).
import { Button, Drawer, Segmented } from '@/components/ui';
import type { PlaySettings } from '@/lib/game/settings';
import type { AskToPay } from '@play/targeting';
import type { QualitySetting } from '@/lib/gl/support';
import styles from './table.module.css';

export interface TableSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  settings: PlaySettings;
  onChange: (patch: Partial<PlaySettings>) => void;
  tutorialOff: boolean;
  onTutorialOff: (off: boolean) => void;
  onResetTutorial: () => void;
  /** Present when the WebGL card renderer is mounted (its quality can be changed live). */
  glQuality?: QualitySetting;
  systemReducedMotion?: boolean;
}

type SpeedKey = '0.5' | '1' | '2' | '4';

export function TableSettingsSheet({ open, onClose, settings, onChange, tutorialOff, onTutorialOff, onResetTutorial, glQuality, systemReducedMotion }: TableSettingsSheetProps) {
  const speedKey = String(settings.speed) as SpeedKey;
  return (
    <Drawer open={open} onClose={onClose} title="Table settings" width={400}>
      <div className={styles.settingsSheet} data-testid="table-settings">
        <section className={styles.settingsGroup}>
          <h3 className={styles.settingsTitle}>Playback</h3>
          <div className={styles.settingsField}>
            <span className={styles.settingsLabel}>Speed</span>
            <Segmented size="sm" label="Playback speed" value={['0.5', '1', '2', '4'].includes(speedKey) ? speedKey : '1'} onChange={v => onChange({ speed: Number(v) })} options={[{ value: '0.5', label: '½×' }, { value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
          </div>
          <div className={styles.settingsField}>
            <span className={styles.settingsLabel}>Reduced motion</span>
            <Segmented<PlaySettings['reducedMotion']> size="sm" label="Reduced motion" value={settings.reducedMotion} onChange={v => onChange({ reducedMotion: v })} options={[{ value: 'system', label: `System${systemReducedMotion ? ' (on)' : ''}` }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
            <p className="faint small">On: changes apply instantly and the queue plays without animation.</p>
          </div>
          <label className={styles.settingsRow}><input type="checkbox" checked={settings.explain} onChange={e => onChange({ explain: e.target.checked })} data-testid="setting-explain" /> Start tables in Explain mode (rule chips next to every animation, half speed)</label>
          <label className={styles.settingsRow} title="No sound yet"><input type="checkbox" checked={false} disabled data-testid="setting-sound" /> Sound <span className="faint">(coming later)</span></label>
        </section>

        <section className={styles.settingsGroup}>
          <h3 className={styles.settingsTitle}>Mana payment</h3>
          <div className={styles.settingsField}>
            <span className={styles.settingsLabel}>Ask which sources to tap</span>
            <Segmented<AskToPay> size="sm" label="Ask to pay" value={settings.askToPay} onChange={v => onChange({ askToPay: v })} options={[{ value: 'never', label: 'Never', title: 'The engine taps for you' }, { value: 'when-ambiguous', label: 'When it matters', title: 'Only when you have untapped sources of more than one colour beyond what the cost needs' }, { value: 'always', label: 'Always' }]} />
            <p className="faint small" data-testid="setting-ask-to-pay" data-value={settings.askToPay}>The engine's suggestion is what it will do; the tray only overrides it. Undo takes back an auto-tap like any other action.</p>
          </div>
        </section>

        <section className={styles.settingsGroup}>
          <h3 className={styles.settingsTitle}>Cards</h3>
          <div className={styles.settingsField}>
            <span className={styles.settingsLabel}>WebGL quality</span>
            <Segmented<QualitySetting> size="sm" label="WebGL quality" value={glQuality ?? settings.glQuality} onChange={v => onChange({ glQuality: v })} options={[{ value: 'auto', label: 'Auto' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
          </div>
        </section>

        <section className={styles.settingsGroup}>
          <h3 className={styles.settingsTitle}>Tutorial</h3>
          <label className={styles.settingsRow}><input type="checkbox" checked={!tutorialOff} onChange={e => onTutorialOff(!e.target.checked)} /> Show tutorial tips</label>
          <Button size="sm" variant="quiet" onClick={onResetTutorial} data-testid="tutorial-reset">Reset tutorial</Button>
        </section>
      </div>
    </Drawer>
  );
}
