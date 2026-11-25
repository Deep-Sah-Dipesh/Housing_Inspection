import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { useAppStore } from '../../store/appStore';
import { formatAgentName, formatDisplayDateTime } from '../../utils/authorHelpers';
import { createFullBackup, restoreFullBackup } from '../../utils/backupHelpers';

const PLAY_STORE_MARKET_URL = 'market://details?id=com.deepsah.housinginspection';
const PLAY_STORE_WEB_URL =
  'https://play.google.com/store/apps/details?id=com.deepsah.housinginspection';

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const { userId, userName, officialName, setOfficialName, logout } = useAppStore();

  const appVersion = Constants.expoConfig?.version || '1.0.0';
  const appVariant =
    Updates.channel === 'production'
      ? 'Play Store'
      : Updates.channel === 'preview'
      ? 'Preview'
      : 'Development';

  const formattedAgentName = formatAgentName(userName);

  const [versionUpdatedAt, setVersionUpdatedAt] = useState<string | null>(null);
  const [showOfficialNameModal, setShowOfficialNameModal] = useState(false);
  const [officialNameInput, setOfficialNameInput] = useState('');

  const [isBusy, setIsBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState('');
  const [busyPercent, setBusyPercent] = useState(0);

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
      'Are you sure you want to log out? You will need your credentials to log back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: () => {
            logout();
            router.replace('/');
          },
        },
      ]
    );
  };

  const executeBackupWithAuthor = async (authorToUse: string) => {
    setIsBusy(true);
    setBusyMessage('Preparing full backup...');
    setBusyPercent(0);
    try {
      const result = await createFullBackup(db, authorToUse, (msg, pct) => {
        setBusyMessage(msg);
        setBusyPercent(pct);
      });
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
    if (officialName && officialName.trim().length > 0) {
      Alert.alert(
        'Confirm Backup Signature',
        `This backup will be permanently signed with your locked Official Name:\n\n"${officialName}"\n\nProceed with creating the backup?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign & Create Backup',
            onPress: () => executeBackupWithAuthor(officialName),
          },
        ]
      );
    } else {
      setOfficialNameInput('');
      setShowOfficialNameModal(true);
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

  const handleLockOfficialNameAndBackup = async () => {
    const trimmed = officialNameInput.trim();
    if (!trimmed) {
      Alert.alert('Required', 'Please enter your Full Official Name.');
      return;
    }
    setOfficialName(trimmed);
    setShowOfficialNameModal(false);
    await executeBackupWithAuthor(trimmed);
  };

  const handleRestoreBackup = async () => {
    setIsBusy(true);
    setBusyMessage('Select a backup .zip file...');
    setBusyPercent(5);
    try {
      const summary = await restoreFullBackup(db, (msg, pct) => {
        setBusyMessage(msg);
        setBusyPercent(pct);
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
        <Text style={styles.sectionLabel}>AGENT PROFILE</Text>
        <View style={styles.card}>
          <View style={styles.profileHeaderRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.agentName}>{formattedAgentName}</Text>
              {userId ? <Text style={styles.agentSubId}>{userId}</Text> : null}
            </View>
          </View>

          {officialName ? (
            <View style={styles.lockedNameBadge}>
              <Ionicons name="lock-closed" size={15} color="#1D4ED8" style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.lockedNameCaption}>Locked Official Name</Text>
                <Text style={styles.lockedNameValue}>{officialName}</Text>
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
                Official Name will be locked when you create your first backup.
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
        <Text style={styles.sectionLabel}>BACKUP & RESTORE</Text>
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
        <Text style={styles.sectionLabel}>APP INFORMATION</Text>
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>App Version</Text>
            <Text style={styles.infoVal}>v{appVersion}</Text>
          </View>
          <View style={styles.rowDivider} />
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>Variant</Text>
            <Text style={styles.infoVal}>{appVariant}</Text>
          </View>
          <View style={styles.rowDivider} />
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>Install / Last Updated</Text>
            <Text style={styles.infoVal}>{formatDisplayDateTime(versionUpdatedAt)}</Text>
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

      {/* Official Name Lock Modal */}
      <Modal visible={showOfficialNameModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Ionicons name="shield-checkmark" size={24} color="#2563EB" style={{ marginRight: 10 }} />
              <Text style={styles.modalTitle}>Set Official Author Name</Text>
            </View>
            <Text style={styles.modalWarningText}>
              Enter your Full Official Name to sign your inspection reports and backups. Once set,
              this name is permanently locked and cannot be changed later.
            </Text>
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
                onPress={handleLockOfficialNameAndBackup}
              >
                <Text style={styles.modalConfirmText}>Lock & Backup</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Progress Modal */}
      <Modal visible={isBusy} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.progressCard}>
            <ActivityIndicator size="large" color="#2563EB" style={{ marginBottom: 14 }} />
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${busyPercent}%` }]} />
            </View>
            <Text style={styles.progressPercent}>{busyPercent}%</Text>
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
    fontSize: 12,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginLeft: 4,
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
  agentName: { fontSize: 22, fontWeight: '800', color: '#0F172A' },
  agentSubId: { fontSize: 13, color: '#64748B', marginTop: 2, fontWeight: '500' },

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
  infoVal: { fontSize: 14, color: '#0F172A', fontWeight: '700' },
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
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#0F172A' },
  modalWarningText: { fontSize: 13, color: '#475569', lineHeight: 19, marginBottom: 16 },
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
    padding: 26,
    width: '85%',
    maxWidth: 340,
    alignItems: 'center',
  },
  progressBarBg: {
    width: '100%',
    height: 10,
    backgroundColor: '#E2E8F0',
    borderRadius: 5,
    overflow: 'hidden',
    marginBottom: 10,
  },
  progressBarFill: { height: '100%', backgroundColor: '#2563EB' },
  progressPercent: { fontSize: 15, fontWeight: '800', color: '#2563EB', marginBottom: 4 },
  progressMsg: { fontSize: 13, color: '#475569', textAlign: 'center' },
});
