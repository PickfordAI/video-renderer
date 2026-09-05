export function validStreamUrl(raw, pageProtocol) {
  const url = new URL(raw);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === 'https:' || (pageProtocol === 'http:' && local && url.protocol === 'http:'))) throw new Error('Invalid stream link.');
  return url.toString();
}

export function setupMessage({ setup, story }) {
  if (story?.state === 'failed') return 'Your story stopped unexpectedly. Ask your agent to check it before starting again.';
  if (story?.state === 'stopped') return 'Your story has stopped. Ask your agent when you’re ready for another.';
  if (story?.state === 'connecting') return 'Your agent is starting the story…';
  return setup.ready ? 'Everything is connected. Ask your agent to start your story.' : 'Your player is ready. Your agent has a little setup left to finish.';
}
