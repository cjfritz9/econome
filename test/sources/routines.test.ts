import { describe, expect, it } from 'vitest';
import { routinesClient } from '../../src/sources/routines.ts';

const trigger = { url: 'https://api.example.com/v1/claude_code/routines/trig_1/fire', token: 'routine-token' };

describe('routinesClient', () => {
  it("fires a routine through its web trigger with the payload as JSON text, and returns the run", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchJson: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ type: 'routine_fire', claude_code_session_id: 'cse_1', claude_code_session_url: 'https://claude.example.com/code/cse_1' });
    };

    const run = await routinesClient(fetchJson).fire(trigger, { fill_id: 'f1' });

    expect(run).toEqual({ sessionId: 'cse_1', sessionUrl: 'https://claude.example.com/code/cse_1' });
    expect(requests).toEqual([
      {
        url: trigger.url,
        init: expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ authorization: 'Bearer routine-token', 'anthropic-beta': 'experimental-cc-routine-2026-04-01' }),
          body: JSON.stringify({ text: '{"fill_id":"f1"}' }),
        }),
      },
    ]);
  });

  it('says why when the routine refuses to start', async () => {
    const fetchJson: typeof fetch = async () => new Response('rate limited', { status: 429 });

    await expect(routinesClient(fetchJson).fire(trigger, {})).rejects.toThrow("The routine wouldn't start (429): rate limited");
  });
});
