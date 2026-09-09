import Hls from 'hls.js';
import { audienceMessageInput, setupMessage, validStreamUrl } from './state.js';
import { creatorPanelVisible, creatorStatusSnapshot, startCreatorPanel } from './creator.js';
import { homeStatusMessage } from './creator-state.js';
import { startLivePlayback, syncPlaybackUi } from './playback.js';

const status = document.querySelector('#status');
const video = document.querySelector('#video');
const setup = document.querySelector('#setup');
let hls;
let retry;
let poll;
let disposed = false;
let currentStream;
let generation = 0;
let chatCsrfToken;
let chatPoll;

const chat = document.querySelector('#audience-chat');
const chatForm = document.querySelector('#chat-form');
const chatName = document.querySelector('#chat-name');
const chatMessage = document.querySelector('#chat-message');
const chatSend = document.querySelector('#chat-send');
const chatStatus = document.querySelector('#chat-status');
const chatHistory = document.querySelector('#chat-history');
const chatMessages = document.querySelector('#chat-messages');
const creatorDetails = document.querySelector('#creator-details');
const bundlesDetails = document.querySelector('#bundles-details');
const sentMessageIds = new Set();
let playbackStarted = false;

function updatePlaybackUi() {
  syncPlaybackUi({
    playbackStarted,
    chatReady: Boolean(chatCsrfToken),
    chat,
    creatorDetails,
    bundlesDetails,
  });
}

function showSentMessage(input, messageId) {
  if (typeof messageId === 'string' && sentMessageIds.has(messageId)) return;
  if (typeof messageId === 'string') sentMessageIds.add(messageId);
  const item = document.createElement('li');
  const author = document.createElement('strong');
  author.textContent = `${input.displayName}: `;
  item.append(author, document.createTextNode(input.content));
  chatMessages.append(item);
  chatHistory.hidden = false;
}

function viewerId() {
  try {
    const saved = localStorage.getItem('pickford-audience-viewer-id');
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) return saved;
    const created = crypto.randomUUID();
    localStorage.setItem('pickford-audience-viewer-id', created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

async function updateAudienceChat() {
  try {
    const response = await fetch('/api/audience-chat/session', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Audience chat is unavailable.');
    const value = await response.json();
    chatCsrfToken = value.ready && typeof value.csrfToken === 'string' ? value.csrfToken : undefined;
    updatePlaybackUi();
  } catch {
    chatCsrfToken = undefined;
    updatePlaybackUi();
  }
  if (!disposed) chatPoll = setTimeout(updateAudienceChat, 3000);
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (!chatCsrfToken) throw new Error('Audience chat is reconnecting.');
    const input = audienceMessageInput(chatName.value, chatMessage.value);
    chatSend.disabled = true;
    chatStatus.textContent = 'Sending…';
    const response = await fetch('/api/audience-chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': chatCsrfToken },
      body: JSON.stringify({ ...input, viewerId: viewerId(), idempotencyKey: crypto.randomUUID() }),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 410) {
        chatCsrfToken = undefined;
        chat.hidden = true;
      }
      throw new Error(typeof value.error === 'string' ? value.error : 'The story did not accept the message.');
    }
    showSentMessage(input, value.messageId);
    chatMessage.value = '';
    chatStatus.textContent = value.duplicate ? 'That message was already received.' : 'Message received by the story.';
  } catch (error) {
    chatStatus.textContent = error instanceof Error ? error.message : 'The message could not be sent.';
  } finally {
    chatSend.disabled = false;
  }
});

function clearStream() {
  playbackStarted = false;
  updatePlaybackUi();
  generation++;
  clearTimeout(retry);
  hls?.destroy();
  hls = undefined;
  currentStream = undefined;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
}

function showStream(raw) {
  const streamUrl = validStreamUrl(raw, location.protocol);
  if (currentStream === streamUrl) return;
  clearStream();
  currentStream = streamUrl;
  const version = generation;
  video.hidden = false;
  setup.hidden = true;
  status.textContent = 'Preparing your first scene. This can take a few minutes.';
  const startPlayback = async () => {
    if (disposed || version !== generation) return;
    const result = await startLivePlayback(video);
    if (disposed || version !== generation) return;
    status.textContent = result === 'playing-muted'
      ? 'Now playing muted. Use the player controls to turn on sound.'
      : result === 'playing'
        ? 'Now playing'
        : 'Your story is ready. Press play to watch.';
  };
  const connect = async () => {
    if (disposed || version !== generation) return;
    try {
      const ready = await fetch(streamUrl, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      await ready.body?.cancel();
      if (disposed || version !== generation) return;
      if (!ready.ok) throw new Error('Waiting');
      if (Hls.isSupported()) {
        hls?.destroy();
        hls = new Hls({ liveSyncDurationCount: 3 });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal || disposed || version !== generation) return;
          status.textContent = 'Reconnecting to your story…';
          hls?.destroy();
          clearTimeout(retry);
          retry = setTimeout(connect, 5000);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => { void startPlayback(); });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.addEventListener('loadedmetadata', () => { void startPlayback(); }, { once: true });
        video.src = streamUrl;
      }
      else throw new Error('This browser cannot play this video. Try another browser.');
      status.textContent = 'Starting your story…';
    } catch (error) {
      if (disposed || version !== generation) return;
      const unsupported = error.message.includes('browser');
      status.textContent = unsupported ? error.message : 'Waiting for your story. If it has ended, ask your agent for a new watch link.';
      if (!unsupported) retry = setTimeout(connect, 5000);
    }
  };
  void connect();
}

function showSetup(value) {
  setup.hidden = false;
  status.textContent = setupMessage(value);
  const labels = { videoAccount: 'Video account', storyAccess: 'Story access', storyConnection: 'Story connection' };
  const checks = document.querySelector('#checks');
  checks.replaceChildren(...Object.entries(labels).map(([key, label]) => {
    const row = document.createElement('li');
    row.append(document.createTextNode(label));
    const badge = document.createElement('span');
    const ready = !value.setup.missing.includes(key);
    badge.textContent = ready ? 'Ready' : 'Agent setup needed';
    badge.className = ready ? 'ready' : '';
    row.append(badge);
    return row;
  }));
}

async function followLocalStory() {
  try {
    const response = await fetch('/api/viewer-status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (disposed) return;
    if ([403, 404].includes(response.status)) {
      status.textContent = 'Open the watch link shared by your agent or the story’s creator.';
      return;
    }
    if (!response.ok) throw new Error('Disconnected');
    const value = await response.json();
    if (disposed) return;
    if (value.story?.hlsUrl) {
      showStream(value.story.hlsUrl);
    } else if (value.story && ['connecting', 'running'].includes(value.story.state)) {
      if (currentStream) clearStream();
      setup.hidden = true;
      status.textContent = 'Preparing your first scene. This can take a few minutes.';
    } else if (creatorPanelVisible()) {
      // The creator signs in and picks a StoryBundle here; the agent-setup checklist is retired.
      if (currentStream) clearStream();
      setup.hidden = true;
      status.textContent = homeStatusMessage(creatorStatusSnapshot());
    } else {
      if (currentStream) clearStream();
      showSetup(value);
    }
  } catch {
    status.textContent = 'The renderer is reconnecting. Your agent can check the connection.';
  }
  if (!disposed) poll = setTimeout(followLocalStory, 2000);
}

video.addEventListener('playing', () => {
  playbackStarted = true;
  updatePlaybackUi();
  status.textContent = 'Now playing';
});
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(poll); clearTimeout(chatPoll); clearStream(); });

const raw = location.hash.slice(1) || import.meta.env.VITE_STREAM_URL;
if (raw) {
  try { showStream(location.hash ? decodeURIComponent(raw) : raw); }
  catch { status.textContent = 'This watch link is invalid. Ask your agent for a new link.'; }
} else {
  startCreatorPanel();
  void followLocalStory();
}
void updateAudienceChat();
