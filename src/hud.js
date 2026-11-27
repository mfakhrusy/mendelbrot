const $ = (id) => document.getElementById(id);
const PAUSE_ICON = '<svg viewBox="0 0 24 24"><path d="M8 6v12M16 6v12"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"/></svg>';

export function showError(message) {
  $('error').hidden = false;
  $('error').textContent = message;
}

export function clearError() {
  $('error').hidden = true;
}

export function syncPlayButton(playing) {
  const text = playing ? 'Pause zoom' : 'Resume zoom';
  $('play').ariaLabel = text;
  $('play').title = text + ' (Space)';
  $('play').innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
}

export function updateMagnification(depth) {
  const log10 = depth * Math.LOG10E * Math.LN2;
  $('magnification').innerHTML =
    log10 < 6
      ? (2 ** depth).toLocaleString('en-US', { maximumFractionDigits: 0 }) + '×'
      : (10 ** (log10 % 1)).toFixed(2) + ' × 10<sup>' + Math.floor(log10) + '</sup>';
}
