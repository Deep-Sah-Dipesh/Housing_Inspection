import React, { Component, ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Image, Modal, TouchableOpacity, StyleSheet, Alert, AppState } from 'react-native';
import { Stack } from 'expo-router';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { initDatabase, syncSeedDatasetInBackground } from '../utils/database';
import { useAppStore } from '../store/appStore';

interface UpdateManifestExtra {
  id?: string;
  createdAt?: string;
  metadata?: {
    message?: string;
    releaseNotes?: string;
    description?: string;
    updateMessage?: string;
  };
  extra?: {
    message?: string;
    updateMessage?: string;
    expoClient?: {
      version?: string;
      description?: string;
      extra?: {
        updateMessage?: string;
      };
    };
  };
}

const formatShortUpdateId = (id?: string | null): string => {
  if (!id) return '';
  const compact = id.replace(/[^a-zA-Z0-9]/g, '');
  if (compact.length <= 6) return compact;
  return `${compact.slice(0, 2)}..${compact.slice(-4)}`;
};

const extractUpdateNotes = (manifest: UpdateManifestExtra | undefined): string => {
  if (!manifest) {
    return 'Includes latest dataset updates, performance improvements, and bug fixes.';
  }
  const candidates = [
    manifest.metadata?.message,
    manifest.metadata?.releaseNotes,
    manifest.metadata?.description,
    manifest.metadata?.updateMessage,
    manifest.extra?.updateMessage,
    manifest.extra?.message,
    manifest.extra?.expoClient?.extra?.updateMessage,
    manifest.extra?.expoClient?.description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return 'Includes latest dataset updates, performance improvements, and bug fixes.';
};

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

function BackgroundSeedSync() {
  const db = useSQLiteContext();
  const setSeedSyncing = useAppStore((s) => s.setSeedSyncing);
  const bumpSeedSyncVersion = useAppStore((s) => s.bumpSeedSyncVersion);

  useEffect(() => {
    let active = true;
    setSeedSyncing(true);
    syncSeedDatasetInBackground(db)
      .then((updated) => {
        if (active && updated) {
          bumpSeedSyncVersion();
        }
      })
      .catch((err) => {
        console.error('Background seed sync error:', err);
      })
      .finally(() => {
        if (active) setSeedSyncing(false);
      });

    return () => {
      active = false;
    };
  }, [db, setSeedSyncing, bumpSeedSyncVersion]);

  return null;
}

export default function RootLayout() {
  const { downloadProgress, isDownloading, currentlyRunning } = Updates.useUpdates();
  const currentVersion = Constants.expoConfig?.version || '2.2.0';
  const currentShortId = formatShortUpdateId(currentlyRunning?.updateId);

  const [isReady, setIsReady] = useState(true);
  const [updateMessage, setUpdateMessage] = useState('Initializing Workspace...');
  const [otaReleaseNotes, setOtaReleaseNotes] = useState<string | null>(null);
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
        if (currentlyRunning?.updateId && manifest?.id && manifest.id === currentlyRunning.updateId) {
          return false;
        }
        if (!isInitialLaunch && dismissedUpdateIdRef.current === nextId) {
          return false;
        }
        const nextAppVer = manifest?.extra?.expoClient?.version || currentVersion;
        const nextShortId = formatShortUpdateId(manifest?.id) || 'Latest';
        const nextLabel =
          nextAppVer !== currentVersion
            ? `v${nextAppVer}`
            : nextShortId !== currentShortId
              ? `v${nextAppVer} (${nextShortId})`
              : `v${nextAppVer} (New)`;
        const releaseNotes = extractUpdateNotes(manifest);

        availableUpdateIdRef.current = nextId;
        setTargetVersionLabel(nextLabel);
        setOtaReleaseNotes(releaseNotes);
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
    checkForOtaUpdate(false);
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
    <Modal visible={showUpdatePrompt} transparent animationType="fade" onRequestClose={handleUpdateNextLaunch}>
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

          {otaReleaseNotes && (
            <View style={styles.releaseNotesBox}>
              <Text style={styles.releaseNotesHeading}>What's New</Text>
              <Text style={styles.releaseNotesText}>{otaReleaseNotes}</Text>
            </View>
          )}

          <TouchableOpacity style={styles.primaryUpdateBtn} onPress={handleUpdateNow}>
            <Ionicons name="refresh" size={18} color="#FFFFFF" style={{ marginRight: 8 }} />
            <Text style={styles.primaryUpdateBtnText}>Update Now</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryUpdateBtn} onPress={handleUpdateNextLaunch}>
            <Text
              style={styles.secondaryUpdateBtnText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              Update on Next Launch
            </Text>
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

          {otaReleaseNotes && (
            <View style={[styles.releaseNotesBox, { marginTop: 16, maxWidth: 320 }]}>
              <Text style={styles.releaseNotesHeading}>Update Notes</Text>
              <Text style={styles.releaseNotesText}>{otaReleaseNotes}</Text>
            </View>
          )}
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
        <Suspense fallback={<View style={{ flex: 1, backgroundColor: '#F8FAFC' }} />}>
          <SQLiteProvider databaseName="housing.db" onInit={initDatabase} useSuspense>
            <BackgroundSeedSync />
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
    width: 40,
    height: 40,
    marginRight: 10,
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
    marginBottom: 14,
  },
  releaseNotesBox: {
    width: '100%',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 18,
  },
  releaseNotesHeading: {
    fontSize: 11,
    fontWeight: '800',
    color: '#2563EB',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4,
    textAlign: 'center',
  },
  releaseNotesText: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 18,
    textAlign: 'center',
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