import Hls from 'hls.js';
const status = document.querySelector('#status');
const video = document.querySelector('#video');
let hls;
let retry;
let stopped = false;
try {
  const raw = decodeURIComponent(location.hash.slice(1)) || import.meta.env.VITE_STREAM_URL;
  const url = new URL(raw);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === 'https:' || (location.protocol === 'http:' && local && url.protocol === 'http:'))) throw new Error('Invalid stream link.');
  const streamUrl = url.toString();
  const connect = async () => {
    if (stopped) return;
    try {
      const ready = await fetch(streamUrl, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!ready.ok) throw new Error('Waiting');
      await ready.body?.cancel();
      if (Hls.isSupported()) {
        hls?.destroy();
        hls = new Hls({ liveSyncDurationCount: 3 });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          status.textContent = 'The stream is reconnecting. If the host stopped the story, ask for a new link.';
          hls.destroy();
          retry = setTimeout(connect, 5000);
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = streamUrl;
      else throw new Error('This browser cannot play HLS video.');
      status.textContent = 'The story is live. Press play to watch.';
    } catch (error) {
      status.textContent = error.message.includes('browser') ? error.message : 'Waiting for the next scene. The first scene can take a few minutes.';
      if (!error.message.includes('browser')) retry = setTimeout(connect, 5000);
    }
  };
  void connect();
  document.querySelector('#play').addEventListener('click', () => {
    video.muted = false;
    void video.play().catch(() => { status.textContent = 'The next scene is still loading. Try play again in a moment.'; });
  });
  video.addEventListener('playing', () => { status.textContent = 'Now playing'; });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(retry); hls?.destroy(); });
} catch { status.textContent = 'Open the watch link shared by the story’s creator.'; document.querySelector('#play').hidden = true; }
