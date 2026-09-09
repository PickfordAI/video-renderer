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

export function audienceMessageInput(displayName, content) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  const message = typeof content === 'string' ? content.trim() : '';
  if (!name) throw new Error('Add your name before sending.');
  if (name.length > 80) throw new Error('Your name must be 80 characters or fewer.');
  if (!message) throw new Error('Write a message before sending.');
  if (message.length > 2000) throw new Error('Your message must be 2000 characters or fewer.');
  return { displayName: name, content: message };
}

export function audienceReceiptMessage(response) {
  return response?.duplicate ? 'That message was already received.' : '';
}

export function audienceDisplayName(creatorStatus) {
  const email = creatorStatus?.auth?.signedIn && typeof creatorStatus.auth.email === 'string'
    ? creatorStatus.auth.email.trim()
    : '';
  return email || 'Audience';
}

export function fitTextareaToContent(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}
