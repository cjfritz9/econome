import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { logger } from '../logger.ts';

const PORT = 8765;
const SIGN_IN_MINUTES = 10;

export interface PendingSignIn {
  householdId: string;
  uid: string;
  expiresAt: number;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Économe</title><body style="font-family:system-ui;margin:3rem"><p>${escapeHtml(message)}</p></body>`;

export const signInListener = (complete: (signIn: PendingSignIn, code: string) => Promise<void>, now = () => Date.now()) => {
  const pending = new Map<string, PendingSignIn>();
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;

  const stop = () => {
    clearTimeout(timer);
    server?.close();
    server = undefined;
  };

  const finish = async (state: string | null, code: string | null, error: string | null) => {
    const signIn = state ? pending.get(state) : undefined;
    if (!state || !signIn || signIn.expiresAt < now()) throw new Error('This Kroger sign-in is out of date; start again with connect_kroger.');
    if (!code) throw new Error(`Kroger didn't finish the sign-in${error ? ` (${error})` : ''}; start again with connect_kroger.`);
    pending.delete(state);
    await complete(signIn, code);
  };

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      stop();
      const next = createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
        if (url.pathname !== '/kroger/callback') {
          response.writeHead(404).end();
          return;
        }
        finish(url.searchParams.get('state'), url.searchParams.get('code'), url.searchParams.get('error'))
          .then(() => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Kroger is connected. You can close this tab and go back to the chat.')))
          .catch((error: unknown) => {
            logger.warn({ err: error }, 'Kroger sign-in failed');
            const message = error instanceof Error ? error.message : String(error);
            response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page(message));
          })
          .finally(stop);
      });
      next.once('error', reject);
      next.listen(PORT, 'localhost', () => {
        server = next.unref();
        timer = setTimeout(stop, SIGN_IN_MINUTES * 60_000).unref();
        resolve();
      });
    });

  return {
    start: async (householdId: string, uid: string) => {
      const state = randomBytes(16).toString('hex');
      pending.set(state, { householdId, uid, expiresAt: now() + SIGN_IN_MINUTES * 60_000 });
      const listening = await listen().then(
        () => true,
        (error: unknown) => {
          logger.warn({ err: error }, 'Could not listen for the Kroger sign-in');
          return false;
        },
      );
      return { state, listening };
    },

    stop,

    finishFromUrl: async (address: string) => {
      const url = new URL(address);
      await finish(url.searchParams.get('state'), url.searchParams.get('code'), url.searchParams.get('error'));
      stop();
    },
  };
};
