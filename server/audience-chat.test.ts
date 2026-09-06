import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { AudienceChatGateway } from './audience-chat.js';
import type { ExternalRendererRunManager } from './external-renderer.js';

const viewerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const idempotencyKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function withGateway(
  runState: 'running' | 'connecting',
  callback: (base: string, submit: ReturnType<typeof vi.fn>) => Promise<void>,
): Promise<void> {
  const submit = vi.fn(async () => ({ accepted: true, duplicate: false, messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }));
  const runs = {
    latest: () => ({ state: runState, storyStartStatus: 202, hlsUrl: 'http://127.0.0.1:4174/hls/h3-run/index.m3u8' }),
    submitAudienceMessage: submit,
  } as unknown as ExternalRendererRunManager;
  const gateway = new AudienceChatGateway(runs, {});
  const server = createServer((request, response) => void gateway.handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await callback(base, submit);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('public audience chat gateway', () => {
  it('binds bounded viewer input to the server-held live run', async () => {
    await withGateway('running', async (base, submit) => {
      const session = await (await fetch(`${base}/api/audience-chat/session`)).json() as { csrfToken: string };
      expect(session).toMatchObject({ ready: true, limits: { displayName: 80, message: 2000 } });
      const response = await fetch(`${base}/api/audience-chat/messages`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ viewerId, idempotencyKey, displayName: '  Ada  ', content: '  Turn left  ', storyId: 999, messageChannelId: 'attacker-choice' }),
      });
      expect(response.status).toBe(201);
      expect(submit).toHaveBeenCalledWith({
        externalSubject: `viewer:${viewerId}`,
        idempotencyKey,
        displayName: 'Ada',
        content: 'Turn left',
      });
    });
  });

  it('requires the exact viewer origin and CSRF token', async () => {
    await withGateway('running', async (base, submit) => {
      const session = await (await fetch(`${base}/api/audience-chat/session`)).json() as { csrfToken: string };
      const body = JSON.stringify({ viewerId, idempotencyKey, displayName: 'Ada', content: 'Hello' });
      for (const headers of [
        { Origin: 'https://attacker.example', 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': 'wrong' },
      ]) {
        expect((await fetch(`${base}/api/audience-chat/messages`, { method: 'POST', headers, body })).status).toBe(403);
      }
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it('rejects unsupported methods and oversized public input before relay', async () => {
    await withGateway('running', async (base, submit) => {
      expect((await fetch(`${base}/api/audience-chat/messages`)).status).toBe(405);
      const session = await (await fetch(`${base}/api/audience-chat/session`)).json() as { csrfToken: string };
      const response = await fetch(`${base}/api/audience-chat/messages`, {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ viewerId, idempotencyKey, displayName: 'Ada', content: 'x'.repeat(9_000) }),
      });
      expect(response.status).toBe(400);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it('keeps chat hidden until renderer start has established the story grant', async () => {
    await withGateway('connecting', async (base) => {
      expect(await (await fetch(`${base}/api/audience-chat/session`)).json()).toMatchObject({ ready: false, csrfToken: null });
    });
  });
});
