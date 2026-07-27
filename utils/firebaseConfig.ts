import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAnalytics, isSupported } from 'firebase/analytics';

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

// Safely initialize Analytics ONLY if the environment supports it
export let analytics: any = null;
isSupported().then((supported) => {
  if (supported) {
    analytics = getAnalytics(app);
  }
});

// Paste the API key from your Google Cloud screenshot here
export const GOOGLE_MAPS_API_KEY = "AIzaSyC-dQQXeIrBqRXC6BHenEK-mNoiZ_Zra1o";
