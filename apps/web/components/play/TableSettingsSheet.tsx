'use client';
// Table settings in a drawer: sound (on/off plus volume), haptics, playback speed, reduced motion, the explain
// default, when the pay tray asks, the WebGL quality and the tutorial. Persisted in localStorage
// (`vault.play.settings`). Ticking sound plays a sample so the level is audible while it is being set.
import { Button, Drawer, Segmented } from '@/components/ui';
import type { PlaySettings } from '@/lib/game/settings';
import type { AskToPay } from '@play/targeting';
import type { QualitySetting } from '@/lib/gl/support';
import { hapticsSupported } from '@/lib/audio/haptics';
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
  /** Play one sound so the level can be heard while it is set. */
  onPreviewSound?: () => void;
}

type SpeedKey = '0.5' | '1' | '2' | '4';

export function TableSettingsSheet({ open, onClose, settings, onChange, tutorialOff, onTutorialOff, onResetTutorial, glQuality, systemReducedMotion, onPreviewSound }: TableSettingsSheetProps) {
  const speedKey = String(settings.speed) as SpeedKey;
  const canVibrate = hapticsSupported();
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
        </section>

        <section className={styles.settingsGroup}>
          <h3 className={styles.settingsTitle}>Sound and touch</h3>
          <label className={styles.settingsRow}>
            <input type="checkbox" checked={settings.sound} onChange={e => onChange({ sound: e.target.checked })} data-testid="setting-sound" /> Sound effects
          </label>
          <div className={styles.settingsField} data-testid="setting-volume-field" data-enabled={settings.sound ? 'true' : 'false'}>
            <label className={styles.settingsLabel} htmlFor="sfx-volume">Volume <span className="mono" data-testid="setting-volume-value">{settings.soundVolume}</span></label>
            <input id="sfx-volume" type="range" min={0} max={100} step={5} value={settings.soundVolume} disabled={!settings.sound} className={styles.volumeSlider}
              aria-label="Sound volume" aria-valuetext={`${settings.soundVolume} percent`} data-testid="setting-volume"
              onChange={e => onChange({ soundVolume: Number(e.target.value) })} onPointerUp={onPreviewSound} onKeyUp={onPreviewSound} />
            <p className="faint small">Synthesised, no downloads. Nothing plays above 2× playback or while the queue is catching up.</p>
          </div>
          <label className={styles.settingsRow}>
            <input type="checkbox" checked={settings.haptics} onChange={e => onChange({ haptics: e.target.checked })} data-testid="setting-haptics" /> Haptics {!canVibrate && <span className="faint">(this device has no vibration)</span>}
          </label>
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
