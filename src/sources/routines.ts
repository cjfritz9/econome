import * as z from 'zod';

const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';
const ANTHROPIC_VERSION = '2023-06-01';
const ERROR_SHOWN = 300;

export interface RoutineTrigger {
  url: string;
  token: string;
}

export interface RoutineRun {
  sessionId: string;
  sessionUrl: string;
}

export interface Routines {
  fire: (trigger: RoutineTrigger, payload: unknown) => Promise<RoutineRun>;
}

const FiredSchema = z.object({ claude_code_session_id: z.string().min(1), claude_code_session_url: z.url() });

export const routinesClient = (fetchJson: typeof fetch = fetch): Routines => ({
  fire: async ({ url, token }, payload) => {
    const response = await fetchJson(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': ROUTINE_BETA,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: JSON.stringify(payload) }),
    });
    if (!response.ok) throw new Error(`The routine wouldn't start (${response.status}): ${(await response.text()).slice(0, ERROR_SHOWN)}`);
    const fired = FiredSchema.parse(await response.json());
    return { sessionId: fired.claude_code_session_id, sessionUrl: fired.claude_code_session_url };
  },
});
