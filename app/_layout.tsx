import React, { Component, ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Image, Modal, TouchableOpacity, StyleSheet, Alert, AppState } from 'react-native';
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { initDatabase } from '../utils/database';

interface UpdateManifestExtra {
  id?: string;
  extra?: {
    expoClient?: {
      version?: string;
    };
  };
}

class SQLiteErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  state = { hasError: false, error: '' };

  static getDerivedStateFromError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { hasError: true, error: message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30, backgroundColor: '#FEF2F2' }}>
          <Ionicons name="warning" size={60} color="#EF4444" style={{ marginBottom: 20 }} />
          <Text style={{ color: '#EF4444', fontSize: 22, fontWeight: 'bold', marginBottom: 15, textAlign: 'center' }}>
            Wrong App Launched
          </Text>
          <Text style={{ color: '#1E293B', fontSize: 16, textAlign: 'center', lineHeight: 24, marginBottom: 20 }}>
            The error <Text style={{ fontWeight: 'bold', color: '#B91C1C' }}>"{this.state.error}"</Text> means your phone opened standard Expo Go instead of your custom Development Build.
          </Text>
          <Text style={{ color: '#1E293B', fontSize: 16, textAlign: 'center', lineHeight: 28, fontWeight: 'bold' }}>
            1. Close this app completely.{"\n"}
            2. Go to your phone's Home Screen.{"\n"}
            3. Tap the "Housing Inspection" app directly.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function RootLayout() {
  const { downloadProgress, isDownloading, currentlyRunning } = Updates.useUpdates();
  const currentVersion = Constants.expoConfig?.version || '2.2.0';
  const currentShortId = currentlyRunning?.updateId ? currentlyRunning.updateId.slice(0, 6) : '';

  const [isReady, setIsReady] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('Initializing Secure Workspace...');
  const [targetVersionLabel, setTargetVersionLabel] = useState<string | null>(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);

  const availableUpdateIdRef = useRef<string | null>(null);
  const dismissedUpdateIdRef = useRef<string | null>(null);
  const isCheckingRef = useRef(false);

  const checkForOtaUpdate = useCallback(async (isInitialLaunch: boolean): Promise<boolean> => {
    if (__DEV__ || isCheckingRef.current) return false;
    isCheckingRef.current = true;
    try {
      if (isInitialLaunch) {
        setUpdateMessage('Checking for latest updates...');
      }
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        const manifest = update.manifest as UpdateManifestExtra | undefined;
        const nextId = manifest?.id || 'latest';
        if (!isInitialLaunch && dismissedUpdateIdRef.current === nextId) {
          return false;
        }
        const nextAppVer = manifest?.extra?.expoClient?.version || currentVersion;
        const nextShortId = manifest?.id ? manifest.id.slice(0, 6) : 'Latest';
        const nextLabel =
          nextAppVer !== currentVersion ? `v${nextAppVer}` : `v${nextAppVer} (${nextShortId})`;

        availableUpdateIdRef.current = nextId;
        setTargetVersionLabel(nextLabel);
        if (isInitialLaunch) {
          setUpdateMessage('A new update is available.');
        }
        setShowUpdatePrompt(true);
        return true;
      }
    } catch (e) {
      if (isInitialLaunch) {
        console.log('OTA Update check failed (Offline mode):', e);
      }
    } finally {
      isCheckingRef.current = false;
    }
    return false;
  }, [currentVersion]);

  useEffect(() => {
    let isMounted = true;

    async function prepareApp() {
      const promptShown = await checkForOtaUpdate(true);
      if (isMounted && !promptShown) {
        setUpdateMessage('Starting Workspace...');
        setTimeout(() => {
          if (isMounted) setIsReady(true);
        }, 450);
      }
    }

    prepareApp();
    return () => {
      isMounted = false;
    };
  }, [checkForOtaUpdate]);

  useEffect(() => {
    if (!isReady || __DEV__) return;

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && !showUpdatePrompt) {
        checkForOtaUpdate(false);
      }
    });

    const pollInterval = setInterval(() => {
      if (!showUpdatePrompt) {
        checkForOtaUpdate(false);
      }
    }, 60000);

    return () => {
      appStateSub.remove();
      clearInterval(pollInterval);
    };
  }, [isReady, showUpdatePrompt, checkForOtaUpdate]);

  const handleUpdateNow = async () => {
    setShowUpdatePrompt(false);
    setIsReady(false);
    setUpdateMessage('Downloading new update...');
    try {
      await Updates.fetchUpdateAsync();
      setUpdateMessage('Applying update and restarting...');
      await Updates.reloadAsync();
    } catch {
      Alert.alert('Update Failed', 'Could not download the update right now. It will be retried on your next launch.');
      setUpdateMessage('Starting Workspace...');
      setIsReady(true);
    }
  };

  const handleUpdateNextLaunch = () => {
    dismissedUpdateIdRef.current = availableUpdateIdRef.current;
    setShowUpdatePrompt(false);
    setUpdateMessage('Starting Workspace...');
    setIsReady(true);
  };

  const currentLabel = currentShortId ? `v${currentVersion} (${currentShortId})` : `v${currentVersion}`;
  const progressPct = Math.round((downloadProgress ?? 0) * 100);

  const renderUpdateModal = () => (
    <Modal visible={showUpdatePrompt} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={styles.updateDialog}>
          <View style={styles.dialogIconCircle}>
            <Ionicons name="cloud-download-outline" size={32} color="#2563EB" />
          </View>
          <Text style={styles.dialogTitle}>App Update Available</Text>

          <View style={[styles.versionPill, { marginTop: 8, marginBottom: 14 }]}>
            <Text style={styles.versionText}>{currentLabel}</Text>
            <Ionicons name="arrow-forward" size={14} color="#2563EB" style={{ marginHorizontal: 8 }} />
            <Text style={styles.targetVersionText}>{targetVersionLabel || 'Latest'}</Text>
          </View>

          <Text style={styles.dialogBody}>
            A newer version is available. Would you like to download and install it now, or update on your next launch?
          </Text>

          <TouchableOpacity style={styles.primaryUpdateBtn} onPress={handleUpdateNow}>
            <Ionicons name="refresh" size={18} color="#FFFFFF" style={{ marginRight: 8 }} />
            <Text style={styles.primaryUpdateBtnText}>Update Now</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryUpdateBtn} onPress={handleUpdateNextLaunch}>
            <Text style={styles.secondaryUpdateBtnText}>Update on Next Launch</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  const renderLoadingScreen = (message: string) => (
    <View style={styles.splashContainer}>
        <StatusBar style="dark" />

        <View style={styles.centerCard}>
          <View style={styles.appIconWrapper}>
            <Image
              source={require('../assets/Housing_Inspection_Logo.png')}
              style={styles.appIcon}
              resizeMode="contain"
            />
          </View>
          <Text style={styles.appTitle}>Housing Inspection</Text>

          <View style={styles.versionPill}>
            <Text style={styles.versionText}>{currentLabel}</Text>
            {targetVersionLabel && (
              <>
                <Ionicons name="arrow-forward" size={14} color="#2563EB" style={{ marginHorizontal: 8 }} />
                <Text style={styles.targetVersionText}>{targetVersionLabel}</Text>
              </>
            )}
          </View>

          <ActivityIndicator size="large" color="#2563EB" style={{ marginTop: 22 }} />

          {(isDownloading || progressPct > 0) && (
            <View style={styles.progressWrapper}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(5, progressPct))}%` }]} />
              </View>
              <Text style={styles.progressPctText}>{progressPct}%</Text>
            </View>
          )}

          <Text style={styles.statusMessage}>{message}</Text>
        </View>

        <View style={styles.developerFooter}>
          <Text style={styles.developedByText}>Developed by</Text>
          <View style={styles.developerRow}>
            <Image
              source={require('../assets/Logo_Deep_sah.png')}
              style={styles.developerLogo}
              resizeMode="contain"
            />
            <Text style={styles.developerName}>Dipesh Sah</Text>
          </View>
        </View>

        {renderUpdateModal()}
      </View>
  );

  if (!isReady) {
    return renderLoadingScreen(updateMessage);
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#F8FAFC' }}>
      <StatusBar style="dark" />
      <SQLiteErrorBoundary>
        <Suspense fallback={renderLoadingScreen('Syncing workspace database...')}>
          <SQLiteProvider databaseName="housing.db" onInit={initDatabase} useSuspense>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#F8FAFC' } }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(tabs)" options={{ gestureEnabled: false }} />
              <Stack.Screen name="beneficiary/[id]" />
            </Stack>
          </SQLiteProvider>
        </Suspense>
      </SQLiteErrorBoundary>
      {renderUpdateModal()}
    </View>
  );
}

const styles = StyleSheet.create({
  splashContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 32,
  },
  centerCard: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  appIconWrapper: {
    width: 84,
    height: 84,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    elevation: 3,
  },
  appIcon: {
    width: 64,
    height: 64,
  },
  appTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 12,
  },
  versionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  versionText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#475569',
  },
  targetVersionText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#2563EB',
  },
  progressWrapper: {
    width: '72%',
    alignItems: 'center',
    marginTop: 16,
  },
  progressTrack: {
    width: '100%',
    height: 8,
    backgroundColor: '#E2E8F0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#2563EB',
    borderRadius: 4,
  },
  progressPctText: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: '700',
    color: '#2563EB',
  },
  statusMessage: {
    marginTop: 14,
    color: '#475569',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  developerFooter: {
    alignItems: 'center',
  },
  developedByText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  developerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  developerLogo: {
    width: 32,
    height: 32,
    marginRight: 8,
  },
  developerName: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1E293B',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  updateDialog: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    elevation: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  dialogIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
  },
  dialogTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
  },
  dialogBody: {
    fontSize: 14,
    color: '#475569',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 22,
  },
  primaryUpdateBtn: {
    flexDirection: 'row',
    width: '100%',
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  primaryUpdateBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryUpdateBtn: {
    width: '100%',
    backgroundColor: '#F1F5F9',
    paddingVertical: 13,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryUpdateBtnText: {
    color: '#475569',
    fontSize: 14,
    fontWeight: '700',
  },
});