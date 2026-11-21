import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getAI, GoogleAIBackend, AgentPlatformBackend, type AI } from 'firebase/ai';

export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  googleProvider: GoogleAuthProvider;
  db: Firestore;
  ai: AI;
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export function isFirebaseConfigured(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
  );
}

let cachedServices: FirebaseServices | null = null;

export function getFirebaseServices(): FirebaseServices | null {
  if (!isFirebaseConfigured()) return null;
  if (cachedServices) return cachedServices;

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: 'select_account' });

  const db = getFirestore(app);
  const backendMode = (import.meta.env.VITE_FIREBASE_AI_BACKEND || 'vertexai').toLowerCase();
  const vertexLocation = import.meta.env.VITE_VERTEX_LOCATION || 'global';
  const ai = getAI(app, {
    backend:
      backendMode === 'googleai'
        ? new GoogleAIBackend()
        : new AgentPlatformBackend(vertexLocation),
  });

  cachedServices = { app, auth, googleProvider, db, ai };
  return cachedServices;
}
