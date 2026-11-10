import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import * as z from 'zod';

const env = z
  .object({
    FIREBASE_PROJECT_ID: z.string().min(1),
    ECONOME_ACTING_EMAIL: z.email(),
    FIREBASE_WEB_API_KEY: z.string().min(1),
    FIREBASE_SIGNING_ACCOUNT: z.email(),
  })
  .parse(process.env);

const SignInSchema = z.object({ idToken: z.string().min(1) });

const auth = getAuth(initializeApp({ projectId: env.FIREBASE_PROJECT_ID, serviceAccountId: env.FIREBASE_SIGNING_ACCOUNT }));
const { uid } = await auth.getUserByEmail(env.ECONOME_ACTING_EMAIL);
const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: await auth.createCustomToken(uid), returnSecureToken: true }),
});
if (!response.ok) throw new Error(`Firebase refused the sign-in (${response.status}): ${await response.text()}`);
process.stdout.write(SignInSchema.parse(await response.json()).idToken);
