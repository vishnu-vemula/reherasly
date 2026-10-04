import { initializeApp, getApps } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';

export const firebaseMode = true;

let firebaseAuth = null;
if (firebaseMode) {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('interviewmaster-auth');
    window.localStorage.removeItem('ai-admin-auth');
  }
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  // A missing auth setting must not prevent public pages from rendering.
  if (apiKey && projectId) {
    const app = getApps()[0] || initializeApp({
      apiKey,
      projectId,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    });
    firebaseAuth = getAuth(app);
    if (import.meta.env.DEV && import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL) {
      connectAuthEmulator(firebaseAuth, import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL, { disableWarnings: true });
    }
  }
}

export const auth = firebaseAuth;

export async function getFirebaseToken(forceRefresh = false) {
  if (!auth) return null;
  await auth.authStateReady();
  return auth.currentUser?.getIdToken(forceRefresh) || null;
}
