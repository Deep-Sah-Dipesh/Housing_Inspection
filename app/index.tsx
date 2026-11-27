import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Redirect, useRootNavigationState } from 'expo-router';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { useAppStore } from '../store/appStore';
import { deriveAuthorId, formatAgentName } from '../utils/authorHelpers';
import {
  auth,
  ensureGoogleSignInConfigured,
  GoogleAuthProvider,
  signInWithCredential,
} from '../utils/firebaseConfig';

export default function AuthScreen() {
  const rootNavigationState = useRootNavigationState();
  const { setAuth, userId, _hasHydrated } = useAppStore();

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    ensureGoogleSignInConfigured(true);
  }, []);

  // 1. SAFEGUARD: Wait for router and storage to mount
  if (!rootNavigationState?.key || !_hasHydrated) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>Loading Workspace...</Text>
      </View>
    );
  }

  // 2. PERSISTENCE: If user is logged in (including offline), redirect instantly
  if (userId) {
    return <Redirect href="/(tabs)/beneficiaries" />;
  }

  const handleGoogleSignIn = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const hasWebClientId = ensureGoogleSignInConfigured();
      if (!hasWebClientId) {
        Alert.alert(
          'Configuration Missing',
          'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is missing in this bundle. Please verify your .env / EAS environment configuration.'
        );
        return;
      }

      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await GoogleSignin.signIn();

      if (!isSuccessResponse(response)) {
        // Cancelled by user
        return;
      }

      let idToken = response.data.idToken;
      if (!idToken) {
        try {
          const tokens = await GoogleSignin.getTokens();
          idToken = tokens.idToken || null;
        } catch {
          idToken = null;
        }
      }

      if (!idToken) {
        Alert.alert(
          'Google Sign-In Configuration Required',
          'Google Sign-In did not return an ID token for Firebase authentication. Please ensure Firebase Google Sign-In and Web Client ID are configured.'
        );
        return;
      }

      const credential = GoogleAuthProvider.credential(idToken);
      const userCredential = await signInWithCredential(auth, credential);

      const email = (userCredential.user.email || response.data.user.email || '').trim();
      if (!email) {
        Alert.alert('Sign-In Error', 'No email address was returned by Google.');
        return;
      }

      const displayName = (
        userCredential.user.displayName ||
        response.data.user.name ||
        formatAgentName(email)
      ).trim();

      const authorId = deriveAuthorId(email);
      setAuth(email.toLowerCase(), displayName, authorId, displayName);
    } catch (error: unknown) {
      if (isErrorWithCode(error)) {
        if (error.code === statusCodes.SIGN_IN_CANCELLED) {
          return;
        }
        if (error.code === statusCodes.IN_PROGRESS) {
          Alert.alert('Please Wait', 'Google Sign-In is already in progress.');
          return;
        }
        if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
          Alert.alert(
            'Play Services Unavailable',
            'Google Play Services is not available or needs an update on this device.'
          );
          return;
        }
        if (error.code === '10' || error.message.includes('DEVELOPER_ERROR')) {
          const pkgName = Constants.expoConfig?.android?.package || 'com.deepsah.housinginspection';
          Alert.alert(
            'Google Sign-In Setup Mismatch (Code 10)',
            `This app build's signing SHA-1 fingerprint is not registered for ${pkgName} in Firebase Console, or the Web Client ID does not match the Firebase project.\n\nPlease add your EAS/Play Store/Debug SHA-1 fingerprint for ${pkgName} in Firebase Project Settings and update google-services.json.`
          );
          return;
        }
      }
      const message = error instanceof Error ? error.message : 'Unable to sign in with Google.';
      Alert.alert('Sign-In Failed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.logoWrapper}>
          <Image
            source={require('../assets/Housing_Inspection_Logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        <Text style={styles.title}>Housing Inspection</Text>
        <Text style={styles.subtitle}>
          Sign in with your Google account to verify your field agent identity and access your
          offline workspace.
        </Text>

        <TouchableOpacity
          style={[styles.googleBtn, loading && styles.googleBtnDisabled]}
          onPress={handleGoogleSignIn}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <View style={styles.googleBtnContent}>
              <View style={styles.googleIconPill}>
                <Ionicons name="logo-google" size={18} color="#2563EB" />
              </View>
              <Text style={styles.googleBtnText}>Continue with Google</Text>
            </View>
          )}
        </TouchableOpacity>

        <View style={styles.offlineNote}>
          <Ionicons name="shield-checkmark-outline" size={16} color="#059669" style={{ marginRight: 8 }} />
          <Text style={styles.offlineNoteText}>
            Works offline once signed in. Your reports stay attributed to your verified Google ID.
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
  },
  loadingText: {
    marginTop: 10,
    color: '#64748B',
    fontWeight: 'bold',
  },
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#FFFFFF',
    width: '100%',
    maxWidth: 400,
    padding: 30,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 4,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
  },
  logoWrapper: {
    width: 88,
    height: 88,
    borderRadius: 24,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#DBEAFE',
  },
  logo: {
    width: 60,
    height: 60,
  },
  title: {
    fontSize: 25,
    fontWeight: '800',
    color: '#1E293B',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 13.5,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 20,
  },
  googleBtn: {
    width: '100%',
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
  },
  googleBtnDisabled: {
    opacity: 0.7,
  },
  googleBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleIconPill: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  googleBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  offlineNote: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBF7D0',
    borderRadius: 12,
    padding: 12,
    marginTop: 22,
    width: '100%',
  },
  offlineNoteText: {
    flex: 1,
    fontSize: 12,
    color: '#166534',
    lineHeight: 17,
    fontWeight: '500',
  },
});