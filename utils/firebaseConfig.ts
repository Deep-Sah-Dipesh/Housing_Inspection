import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { initializeApp } from 'firebase/app';
import {
  Auth,
  GoogleAuthProvider,
  Persistence,
  getAuth,
  initializeAuth,
  signInWithCredential,
  signOut,
} from 'firebase/auth';
import * as firebaseAuthModule from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getAnalytics, isSupported, Analytics } from 'firebase/analytics';

// Paste your Firebase Config object here
const firebaseConfig = {
  apiKey: "AIzaSyBGvqUEkSkIQ_xP_U629SmzXA6K3T48_i0",
  authDomain: "housing-inspection-2k26.firebaseapp.com",
  projectId: "housing-inspection-2k26",
  storageBucket: "housing-inspection-2k26.firebasestorage.app",
  messagingSenderId: "818382301555",
  appId: "1:818382301555:web:d69214f95431a3f1affd06",
  measurementId: "G-4V1C4RD699"
};

// Initialize Firebase App ONCE
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

interface FirebaseAuthRnExports {
  getReactNativePersistence?: (storage: typeof AsyncStorage) => Persistence;
}

const rnAuthExports = firebaseAuthModule as unknown as FirebaseAuthRnExports;

const createFirebaseAuth = (): Auth => {
  try {
    const persistence = rnAuthExports.getReactNativePersistence?.(AsyncStorage);
    if (persistence) {
      return initializeAuth(app, { persistence });
    }
    return initializeAuth(app);
  } catch {
    return getAuth(app);
  }
};

export const auth: Auth = createFirebaseAuth();
export { GoogleAuthProvider, signInWithCredential, signOut };

let isGoogleConfigured = false;

/**
 * Ensures `@react-native-google-signin/google-signin` is configured before
 * calling `signIn` or `signOut` (even after app restarts where AuthScreen didn't mount).
 */
export const ensureGoogleSignInConfigured = (force = false): boolean => {
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim();
  if (!isGoogleConfigured || force) {
    GoogleSignin.configure(webClientId ? { webClientId } : {});
    isGoogleConfigured = true;
  }
  return Boolean(webClientId);
};

// Safely initialize Analytics ONLY if the environment supports it
export let analytics: Analytics | null = null;
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
  }
});

// Paste the API key from your Google Cloud screenshot here
export const GOOGLE_MAPS_API_KEY = "AIzaSyC-dQQXeIrBqRXC6BHenEK-mNoiZ_Zra1o";
