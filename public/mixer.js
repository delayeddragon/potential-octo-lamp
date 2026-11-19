/**
 * RuneDeck — the audio mixer.
 *
 * One small control for the page's SoundEngine, shown twice: in the lobby's top
 * bar and in the match HUD beside Leave Match. The speaker mutes and unmutes
 * with one click, as M does from the keyboard; the button beside it opens a
 * panel with the Music and SFX volumes. The engine keeps all three in
 * localStorage and tells every mixer when one changes, so the two always agree.
 */

const MARKUP = `
  <button class="mixer-mute" type="button" aria-label="Mute sound" aria-pressed="false">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path class="snd-body" d="M3 9.5h3.6l4.9-4v13l-4.9-4H3z"/>
      <path class="snd-wave" d="M14.2 9.6a3.4 3.4 0 0 1 0 4.8"/>
      <path class="snd-wave w2" d="M16.4 7.4a6.5 6.5 0 0 1 0 9.2"/>
      <path class="snd-wave w3" d="M18.6 5.2a9.6 9.6 0 0 1 0 13.6"/>
      <path class="snd-off" d="m15 9.5 5 5m0-5-5 5"/>
    </svg>
    <kbd>M</kbd>
  </button>
  <button class="mixer-toggle" type="button" aria-label="Audio mixer" aria-expanded="false" title="Music and SFX volume">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4v7m0 4v5M12 4v2m0 4v10M18 4v9m0 4v3"/>
      <path class="mixer-knob" d="M3.8 13h4.4M9.8 8h4.4M15.8 15h4.4"/>
    </svg>
  </button>
  <div class="mixer-panel" role="group" aria-label="Audio mixer" hidden>
    <label class="mixer-row"><span>Music</span><input type="range" min="0" max="100" step="1" data-channel="music"><output></output></label>
    <label class="mixer-row"><span>SFX</span><input type="range" min="0" max="100" step="1" data-channel="sfx"><output></output></label>
  </div>`;

/** The keys a slider moves by: in a match the arrows would otherwise pan the camera instead. */
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** While the SFX slider is dragged, a sound at the new volume is played this often at most. */
const PREVIEW_MS = 160;

let serial = 0;

/** What the speaker shows: crossed out when nothing can be heard, else one to three waves for the louder volume. */
function bars({ muted, musicVolume, sfxVolume }) {
  return muted ? 0 : Math.min(3, Math.ceil(Math.max(musicVolume, sfxVolume) * 3 - 1e-6));
}

/**
 * Builds a mixer for `sound` inside `root`. Returns `{ close }`, which shuts its
 * panel: for when the screen it sits on goes away.
 */
export function createMixer(root, sound) {
  root.classList.add('mixer');
  root.innerHTML = MARKUP;
  const mute = root.querySelector('.mixer-mute');
  const toggle = root.querySelector('.mixer-toggle');
  const panel = root.querySelector('.mixer-panel');
  const sliders = Object.fromEntries([...root.querySelectorAll('input')].map((input) => [input.dataset.channel, { input, readout: input.nextElementSibling }]));
  panel.id = `mixer-panel-${++serial}`;
  toggle.setAttribute('aria-controls', panel.id);
  let open = false;
  let previewAt = 0;

  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  sound.subscribe((engine) => {
    root.dataset.level = String(bars(engine));
    mute.setAttribute('aria-pressed', String(engine.muted));
    mute.title = engine.muted ? 'Sound is muted. Click or press M to unmute.' : 'Click or press M to mute all sound.';
    for (const [channel, volume] of [['music', engine.musicVolume], ['sfx', engine.sfxVolume]]) {
      const { input, readout } = sliders[channel];
      const percent = Math.round(volume * 100);
      input.value = String(percent);
      input.style.setProperty('--fill', `${percent}%`);
      input.setAttribute('aria-valuetext', `${percent}%`);
      readout.textContent = String(percent);
    }
  });

  mute.addEventListener('click', () => {
    // Coming back from silence is confirmed by a click that can be heard.
    if (!sound.toggleMute()) sound.play('uiClick');
  });
  toggle.addEventListener('click', () => setOpen(!open));
  sliders.music.input.addEventListener('input', (event) => sound.setMusicVolume(event.target.value / 100));
  sliders.sfx.input.addEventListener('input', (event) => {
    sound.setSfxVolume(event.target.value / 100);
    // There may be nothing else to judge the new volume by.
    const now = performance.now();
    if (now - previewAt >= PREVIEW_MS) {
      previewAt = now;
      sound.play('elixir');
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement && SLIDER_KEYS.has(event.key)) event.stopPropagation();
  });
  // Escape and a press anywhere else close the panel. With the keyboard inside it, Escape does only that.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !open) return;
      setOpen(false);
      if (root.contains(document.activeElement)) {
        toggle.focus();
        event.stopPropagation();
      }
    },
    true,
  );
  document.addEventListener('pointerdown', (event) => {
    if (open && !root.contains(event.target)) setOpen(false);
  });

  return { close: () => setOpen(false) };
}

/** M mutes and unmutes all sound from anywhere on the page, except while a text field is being typed in. */
export function bindMuteKey(sound) {
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyM' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const { target } = event;
    if (target instanceof HTMLTextAreaElement || target.isContentEditable || (target instanceof HTMLInputElement && target.type !== 'range')) return;
    if (!sound.toggleMute()) sound.play('uiClick');
  });
}
