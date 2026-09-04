export function watchUrlForStream(hlsUrl, viewerUrl) {
  let stream, viewer;
  try {
    stream = new URL(hlsUrl);
    viewer = new URL(viewerUrl || '/', stream);
  } catch { throw new Error('Start a story with a valid stream URL before sharing.'); }
  for (const url of [stream, viewer]) {
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new Error('Watch links require HTTPS (loopback HTTP is allowed locally).');
  }
  viewer.hash = encodeURIComponent(stream.toString());
  return viewer.toString();
}
