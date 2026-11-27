import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { Directory, File } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { useAppStore } from '../../store/appStore';
import {
  deriveAuthorId,
  formatDateAndTimeParts,
  formatEtaRemaining,
  resolveAuthorName,
} from '../../utils/authorHelpers';
import { createFullBackup, restoreFullBackup } from '../../utils/backupHelpers';
import { auth, ensureGoogleSignInConfigured, signOut } from '../../utils/firebaseConfig';

const PLAY_STORE_MARKET_URL = 'market://details?id=com.deepsah.housinginspection';
const PLAY_STORE_WEB_URL =
  'https://play.google.com/store/apps/details?id=com.deepsah.housinginspection';

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const {
    userId,
    authorId,
    userName,
    officialName,
    officialNameLocked,
    setOfficialName,
    lockOfficialName,
    logout,
  } = useAppStore();

  const { currentlyRunning } = Updates.useUpdates();
  const appVersion = Constants.expoConfig?.version || '1.0.0';
  const rawUpdateId = currentlyRunning?.updateId || Updates.updateId;
  const updateIdDisplay = rawUpdateId ? rawUpdateId.slice(0, 8) : 'Embedded';
  const appVariant =
    Updates.channel === 'production'
      ? 'Play Store'
      : Updates.channel === 'preview'
      ? 'Preview'
      : 'Development';

  const resolvedAuthorId = authorId || deriveAuthorId(userId);
  const displayAgentName = resolveAuthorName(officialName, userName);

  const [versionUpdatedAt, setVersionUpdatedAt] = useState<string | null>(null);
  const [showOfficialNameModal, setShowOfficialNameModal] = useState(false);
  const [officialNameInput, setOfficialNameInput] = useState('');
  const [modalActionMode, setModalActionMode] = useState<'edit_only' | 'lock_and_backup'>('edit_only');

  const [isBusy, setIsBusy] = useState(false);
  const [busyTitle, setBusyTitle] = useState('Processing...');
  const [busyMessage, setBusyMessage] = useState('');
  const [busyPercent, setBusyPercent] = useState(0);
  const [etaText, setEtaText] = useState('Calculating remaining time...');

  const operationStartRef = useRef<number>(Date.now());
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: Math.min(100, Math.max(0, busyPercent)),
      duration: 240,
      useNativeDriver: false,
    }).start();
  }, [busyPercent, progressAnim]);

  useEffect(() => {
    if (!isBusy) return;
    const updateEta = () => {
      const elapsed = Date.now() - operationStartRef.current;
      setEtaText(formatEtaRemaining(elapsed, busyPercent));
    };
    updateEta();
    const timer = setInterval(updateEta, 500);
    return () => clearInterval(timer);
  }, [isBusy, busyPercent]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          const row = await db.getFirstAsync<{ value: string }>(
            `SELECT value FROM app_metadata WHERE key = 'app_version_updated_at'`
          );
          if (active && row?.value) {
            setVersionUpdatedAt(row.value);
          }
        } catch {
          // Ignore metadata read errors
        }
      })();
      return () => {
        active = false;
      };
    }, [db])
  );

  const handleLogout = () => {
    Alert.alert(
      'Secure Logout',
      'Are you sure you want to log out? You will need to sign in with Google again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            try {
              ensureGoogleSignInConfigured();
              if (GoogleSignin.hasPreviousSignIn()) {
                await GoogleSignin.signOut();
              }
            } catch {}
            try {
              await signOut(auth);
            } catch {}
            logout();
            router.replace('/');
          },
        },
      ]
    );
  };

  const openEditNameModal = (mode: 'edit_only' | 'lock_and_backup') => {
    if (officialNameLocked) return;
    setModalActionMode(mode);
    setOfficialNameInput(officialName || displayAgentName || '');
    setShowOfficialNameModal(true);
  };

  const executeBackupWithAuthor = async (authorToUse: string) => {
    operationStartRef.current = Date.now();
    progressAnim.setValue(0);
    setBusyTitle('Creating Full Backup');
    setBusyMessage('Preparing full backup...');
    setBusyPercent(2);
    setEtaText('Calculating remaining time...');
    setIsBusy(true);

    try {
      const result = await createFullBackup(
        db,
        authorToUse,
        (msg, pct) => {
          setBusyMessage(msg);
          setBusyPercent(pct);
          const elapsed = Date.now() - operationStartRef.current;
          setEtaText(formatEtaRemaining(elapsed, pct));
        },
        resolvedAuthorId
      );
      setIsBusy(false);

      Alert.alert(
        'Backup Ready',
        `Backed up ${result.projectCount} project(s) and ${result.photoCount} photo(s).\nSigned by: ${authorToUse}`,
        [
          {
            text: 'Save to Folder',
            onPress: async () => {
              try {
                const pickedDir = await Directory.pickDirectoryAsync();
                const zipFile = new File(result.zipUri);
                const destFile = pickedDir.createFile(result.zipFilename, 'application/zip');
                const bytes = await zipFile.bytes();
                destFile.write(bytes);
                Alert.alert('Saved', `Backup saved as ${result.zipFilename}.`);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : '';
                if (msg.toLowerCase().includes('cancel')) return;
                Alert.alert(
                  'Save Failed',
                  'Could not save directly to that folder. Please use Share instead.'
                );
              }
            },
          },
          {
            text: 'Share',
            onPress: () => {
              Sharing.shareAsync(result.zipUri);
            },
          },
          { text: 'Done', style: 'cancel' },
        ]
      );
    } catch (err: unknown) {
      setIsBusy(false);
      const message = err instanceof Error ? err.message : 'Could not create backup.';
      Alert.alert('Backup Failed', message);
    }
  };

  const handleConfirmAuthorAndBackup = () => {
    const activeName = (officialName || displayAgentName).trim();
    if (officialNameLocked && activeName) {
      Alert.alert(
        'Confirm Backup Signature',
        `This backup will be signed with your locked Official Name:\n\n"${activeName}"\n\nProceed with creating the backup?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign & Create Backup',
            onPress: () => executeBackupWithAuthor(activeName),
          },
        ]
      );
    } else {
      openEditNameModal('lock_and_backup');
    }
  };

  const handleStartBackupFlow = () => {
    Alert.alert(
      'Before Creating Backup',
      'To save storage space and keep your archive clean, please delete any unwanted projects or test photos first before backing up.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Proceed to Backup',
          onPress: handleConfirmAuthorAndBackup,
        },
      ]
    );
  };

  const handleConfirmOfficialName = async () => {
    const trimmed = officialNameInput.trim();
    if (!trimmed) {
      Alert.alert('Required', 'Please enter your Full Official Name.');
      return;
    }
    setOfficialName(trimmed, true);
    lockOfficialName();
    setShowOfficialNameModal(false);

    if (modalActionMode === 'lock_and_backup') {
      await executeBackupWithAuthor(trimmed);
    }
  };

  const handleRestoreBackup = async () => {
    operationStartRef.current = Date.now();
    progressAnim.setValue(0);
    setBusyTitle('Restoring Backup');
    setBusyMessage('Select a backup .zip file...');
    setBusyPercent(2);
    setEtaText('Calculating remaining time...');
    setIsBusy(true);

    try {
      const summary = await restoreFullBackup(db, (msg, pct) => {
        setBusyMessage(msg);
        setBusyPercent(pct);
        const elapsed = Date.now() - operationStartRef.current;
        setEtaText(formatEtaRemaining(elapsed, pct));
      });
      setIsBusy(false);
      if (!summary) {
        return;
      }

      const authorsText =
        summary.authorsFound.length > 0 ? summary.authorsFound.join(', ') : 'None';
      Alert.alert(
        'Restore Complete',
        `Projects Restored: ${summary.projectsRestored}\nExact Duplicates Skipped: ${summary.projectsSkipped}\nPhotos Restored: ${summary.photosRestored}\nAuthors Found: ${authorsText}`
      );
    } catch (err: unknown) {
      setIsBusy(false);
      const message = err instanceof Error ? err.message : 'Failed to restore backup.';
      if (message.toLowerCase().includes('cancel')) return;
      Alert.alert('Restore Failed', message);
    }
  };

  const handleCheckForUpdates = async () => {
    try {
      const canOpenMarket = await Linking.canOpenURL(PLAY_STORE_MARKET_URL);
      if (canOpenMarket) {
        await Linking.openURL(PLAY_STORE_MARKET_URL);
      } else {
        await Linking.openURL(PLAY_STORE_WEB_URL);
      }
    } catch {
      try {
        await Linking.openURL(PLAY_STORE_WEB_URL);
      } catch {
        Alert.alert('Error', 'Unable to open Google Play Store on this device.');
      }
    }
  };

  const updatedParts = formatDateAndTimeParts(versionUpdatedAt);
  const animatedWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      {/* 1. Agent Profile Section */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Agent Profile</Text>
        <View style={styles.card}>
          <View style={styles.profileHeaderRow}>
            <View style={{ flex: 1, marginRight: 10 }}>
              <Text style={styles.agentName}>{displayAgentName}</Text>
              {userId ? <Text style={styles.agentSubId}>{userId}</Text> : null}
              {resolvedAuthorId ? (
                <Text style={styles.agentAuthorId}>Author ID: {resolvedAuthorId}</Text>
              ) : null}
            </View>
            {!officialNameLocked && (
              <TouchableOpacity
                style={styles.editNameBtn}
                onPress={() => openEditNameModal('edit_only')}
                activeOpacity={0.8}
              >
                <Ionicons name="pencil" size={18} color="#2563EB" />
              </TouchableOpacity>
            )}
          </View>

          {officialNameLocked ? (
            <View style={styles.lockedNameBadge}>
              <Ionicons name="lock-closed" size={15} color="#1D4ED8" style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.lockedNameCaption}>Locked Official Name</Text>
                <Text style={styles.lockedNameValue}>{officialName || displayAgentName}</Text>
              </View>
            </View>
          ) : (
            <View style={styles.unlockedNotice}>
              <Ionicons
                name="information-circle-outline"
                size={16}
                color="#64748B"
                style={{ marginRight: 8 }}
              />
              <Text style={styles.unlockedNoticeText}>
                Your Official Name will be locked permanently once edited here or when creating your
                first backup.
              </Text>
            </View>
          )}

          <View style={styles.divider} />

          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.8}>
            <Ionicons name="log-out-outline" size={20} color="#EF4444" style={{ marginRight: 8 }} />
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 2. Backup & Restore Section */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Backup & Restore</Text>
        <View style={styles.card}>
          <Text style={styles.sectionDescription}>
            Export a tamper-resistant archive of all inspected projects, photos, notes, and author
            attribution, or restore from a previous backup.
          </Text>

          <TouchableOpacity
            style={styles.primaryActionBtn}
            onPress={handleStartBackupFlow}
            activeOpacity={0.85}
          >
            <Ionicons name="cloud-upload-outline" size={20} color="#FFFFFF" style={{ marginRight: 10 }} />
            <Text style={styles.primaryActionText}>Create Full Backup</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryActionBtn}
            onPress={handleRestoreBackup}
            activeOpacity={0.85}
          >
            <Ionicons name="cloud-download-outline" size={20} color="#2563EB" style={{ marginRight: 10 }} />
            <Text style={styles.secondaryActionText}>Restore from Backup</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 3. App Information Section */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>App Information</Text>
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>App Version</Text>
            <Text style={styles.infoVal}>v{appVersion}</Text>
          </View>
          <View style={styles.rowDivider} />
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>Update ID</Text>
            <Text style={styles.infoVal}>{updateIdDisplay}</Text>
          </View>
          <View style={styles.rowDivider} />
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>Variant</Text>
            <Text style={styles.infoVal}>{appVariant}</Text>
          </View>
          <View style={styles.rowDivider} />
          <View style={styles.twoLineInfoRow}>
            <View style={styles.twoLineKeyCol}>
              <Text style={styles.infoKey}>Last Updated</Text>
              <Text style={styles.infoKeySub}>or Installed</Text>
            </View>
            <View style={styles.twoLineValCol}>
              <Text style={styles.infoVal}>{updatedParts.date}</Text>
              <Text style={styles.infoValSub}>{updatedParts.time}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.updateBtn}
            onPress={handleCheckForUpdates}
            activeOpacity={0.85}
          >
            <Ionicons name="logo-google-playstore" size={18} color="#0F172A" style={{ marginRight: 8 }} />
            <Text style={styles.updateBtnText}>Check for Updates</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Official Name Edit & Permanent Lock Modal */}
      <Modal
        visible={showOfficialNameModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOfficialNameModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Ionicons name="shield-checkmark" size={24} color="#2563EB" style={{ marginRight: 10 }} />
              <Text style={styles.modalTitle}>Set Official Name</Text>
            </View>
            <View style={styles.oneTimeWarningBox}>
              <Ionicons name="warning-outline" size={18} color="#B45309" style={{ marginRight: 8, marginTop: 1 }} />
              <Text style={styles.oneTimeWarningText}>
                This name can only be changed <Text style={{ fontWeight: '800' }}>once</Text> and{' '}
                <Text style={{ fontWeight: '800' }}>cannot be undone</Text>. Once saved, it is
                permanently locked for all reports and backups.
              </Text>
            </View>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g., Rajesh Kumar Sharma"
              placeholderTextColor="#94A3B8"
              value={officialNameInput}
              onChangeText={setOfficialNameInput}
              autoCapitalize="words"
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setShowOfficialNameModal(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirmBtn}
                onPress={handleConfirmOfficialName}
              >
                <Text style={styles.modalConfirmText}>
                  {modalActionMode === 'lock_and_backup' ? 'Lock & Backup' : 'Save & Lock'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Progress Modal with Smooth Bar & ETA */}
      <Modal visible={isBusy} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={styles.modalOverlay}>
          <View style={styles.progressCard}>
            <ActivityIndicator size="large" color="#2563EB" style={{ marginBottom: 10 }} />
            <Text style={styles.progressTitle}>{busyTitle}</Text>
            <View style={styles.progressBarBg}>
              <Animated.View style={[styles.progressBarFill, { width: animatedWidth }]} />
            </View>
            <View style={styles.progressMetaRow}>
              <Text style={styles.progressPercent}>{busyPercent}%</Text>
              <Text style={styles.progressEta}>{etaText}</Text>
            </View>
            <Text style={styles.progressMsg}>{busyMessage}</Text>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  scrollContent: { paddingBottom: 40 },
  header: { paddingHorizontal: 20, paddingVertical: 14 },
  title: { fontSize: 28, fontWeight: '900', color: '#0F172A' },

  section: { marginHorizontal: 20, marginBottom: 22 },
  sectionLabel: {
    fontSize: 14.5,
    fontWeight: '800',
    color: '#475569',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: 10,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    elevation: 1,
  },

  profileHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  agentName: { fontSize: 21, fontWeight: '800', color: '#0F172A' },
  agentSubId: { fontSize: 13, color: '#64748B', marginTop: 2, fontWeight: '500' },
  agentAuthorId: { fontSize: 12, color: '#2563EB', marginTop: 3, fontWeight: '700' },
  editNameBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    justifyContent: 'center',
    alignItems: 'center',
  },

  lockedNameBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 12,
    padding: 12,
  },
  lockedNameCaption: { fontSize: 11, color: '#1D4ED8', fontWeight: '700', textTransform: 'uppercase' },
  lockedNameValue: { fontSize: 15, color: '#1E3A8A', fontWeight: '800', marginTop: 2 },

  unlockedNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 12,
  },
  unlockedNoticeText: { flex: 1, fontSize: 13, color: '#475569', lineHeight: 18 },

  divider: { height: 1, backgroundColor: '#F1F5F9', marginVertical: 16 },
  rowDivider: { height: 1, backgroundColor: '#F1F5F9', marginVertical: 12 },

  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FEF2F2',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  logoutText: { color: '#EF4444', fontSize: 15, fontWeight: '800' },

  sectionDescription: { fontSize: 13, color: '#475569', lineHeight: 19, marginBottom: 14 },
  primaryActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563EB',
    paddingVertical: 13,
    borderRadius: 10,
    marginBottom: 10,
  },
  primaryActionText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  secondaryActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
    paddingVertical: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  secondaryActionText: { color: '#2563EB', fontSize: 15, fontWeight: '800' },

  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  infoKey: { fontSize: 14, color: '#64748B', fontWeight: '600' },
  infoKeySub: { fontSize: 13, color: '#64748B', fontWeight: '600', marginTop: 2 },
  infoVal: { fontSize: 14, color: '#0F172A', fontWeight: '700' },
  infoValSub: { fontSize: 13, color: '#475569', fontWeight: '600', marginTop: 2 },
  twoLineInfoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  twoLineKeyCol: { flexShrink: 1, paddingRight: 12 },
  twoLineValCol: { alignItems: 'flex-end', flexShrink: 1 },
  updateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  updateBtnText: { color: '#0F172A', fontSize: 15, fontWeight: '700' },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 22,
    width: '100%',
    maxWidth: 400,
  },
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  oneTimeWarningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 10,
    padding: 11,
    marginBottom: 14,
  },
  oneTimeWarningText: { flex: 1, fontSize: 12.5, color: '#92400E', lineHeight: 18 },
  modalInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#0F172A',
    marginBottom: 18,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  modalCancelBtn: {
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
  },
  modalCancelText: { color: '#64748B', fontWeight: '700', fontSize: 14 },
  modalConfirmBtn: {
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#2563EB',
  },
  modalConfirmText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },

  progressCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    width: '88%',
    maxWidth: 360,
    alignItems: 'center',
  },
  progressTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginBottom: 14 },
  progressBarBg: {
    width: '100%',
    height: 10,
    backgroundColor: '#E2E8F0',
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: 10,
  },
  progressBarFill: { height: '100%', backgroundColor: '#2563EB', borderRadius: 5 },
  progressMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 8,
  },
  progressPercent: { fontSize: 14, fontWeight: '800', color: '#2563EB' },
  progressEta: { fontSize: 12.5, fontWeight: '600', color: '#64748B' },
  progressMsg: { fontSize: 13, color: '#475569', textAlign: 'center' },
});
