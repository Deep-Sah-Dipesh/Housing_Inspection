import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Modal,
  Alert,
  TextInput,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
  Animated,
  BackHandler,
  PanResponder,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Directory, File, Paths } from 'expo-file-system';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import ViewShot from 'react-native-view-shot';
import * as ImageManipulator from 'expo-image-manipulator';
import { Accelerometer } from 'expo-sensors';
import { generatePhotoFilename, shareProjectsZipArchive } from '../../utils/fileHelpers';
import { GOOGLE_MAPS_API_KEY } from '../../utils/firebaseConfig';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/appStore';
import {
  deriveAuthorId,
  formatDisplayDateTime,
  generateReportId,
  getProjectDirectory,
  getReportDirectory,
  isOwnedByCurrentUser,
  ProjectMeta,
  readProjectMeta,
  resolveAuthorName,
  writeProjectMeta,
  writeReportMeta,
} from '../../utils/authorHelpers';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const COLUMN_COUNT = 2;
const CARD_INNER_WIDTH = SCREEN_WIDTH - 30 - 28; // 15px outer margin each side + 14px card padding each side
const IMAGE_GAP = 10;
const IMAGE_SIZE = (CARD_INNER_WIDTH - IMAGE_GAP) / COLUMN_COUNT;

const ZOOM_STEPS = [0, 0.15, 0.3, 0.5, 0.75, 1.0];
const ZOOM_LABELS = ['1x', '1.5x', '2x', '3x', '4x', '5x'];

const toTitleCase = (str?: string | null) => {
  if (!str) return 'N/A';
  const cleanStr = str.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (!cleanStr) return 'N/A';
  return cleanStr.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
};

const formatGeoDate = (d: Date) => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const p = (n: number) => n.toString().padStart(2, '0');
  const h12 = d.getHours() % 12 || 12;
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const offH = p(Math.floor(Math.abs(offset) / 60));
  const offM = p(Math.abs(offset) % 60);
  const yy = d.getFullYear();
  return `${days[d.getDay()]}, ${p(d.getDate())}/${p(d.getMonth() + 1)}/${yy} ${p(h12)}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ampm} GMT ${sign}${offH}:${offM}`;
};

const DetailRow = ({ label, value }: { label: string; value: string | undefined | null }) => {
  const formattedValue = toTitleCase(value);

  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailColon}>:</Text>
      <Text style={styles.detailValue}>{formattedValue}</Text>
    </View>
  );
};

interface BeneficiaryDetailRecord {
  code: string;
  original_code?: string | null;
  name?: string;
  serial_number?: string;
  annexure_id?: string;
  project_name?: string;
  father_name?: string;
  district_name?: string;
  city_name?: string;
  site_address?: string;
  sync_status?: string;
  author_id?: string | null;
  author_name?: string | null;
  last_updated?: string | null;
}

interface ReportRow {
  id: string;
  beneficiary_code: string;
  author_id?: string | null;
  author_name?: string | null;
  original_author_id?: string | null;
  original_author_name?: string | null;
  notes?: string | null;
  note_filename?: string | null;
  is_edited_copy?: number | null;
  parent_report_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface PhotoRecord {
  id: string;
  beneficiary_code: string;
  report_id?: string | null;
  local_uri: string;
  filename: string;
  latitude?: string;
  longitude?: string;
  author_id?: string | null;
  author_name?: string | null;
  created_at?: string;
}

interface ReportSection {
  id: string;
  isLegacyRoot: boolean;
  authorId: string;
  authorName: string;
  originalAuthorId: string;
  originalAuthorName: string;
  isEditedCopy: boolean;
  parentReportId: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
  noteFilename: string;
  photos: PhotoRecord[];
  isOwnedByYou: boolean;
}

interface LiveGeoData {
  lat: string;
  lon: string;
  address: string;
  shortLocation: string;
  timestamp: string;
}

interface CaptureQueueItem {
  id: number;
  uri: string;
  geoData: LiveGeoData;
  orientation: number;
  aspectRatio: '16:9' | '4:3';
}

const parseSortMs = (iso?: string | null): number => {
  if (!iso) return 0;
  const normalized = iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z';
  const t = new Date(normalized).getTime();
  if (!isNaN(t)) return t;
  const raw = new Date(iso).getTime();
  return isNaN(raw) ? 0 : raw;
};

export default function BeneficiaryAlbumScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();

  const rawId = Array.isArray(id) ? id[0] : (id || '');
  const beneficiaryCode = (() => {
    try {
      return decodeURIComponent(rawId);
    } catch {
      return rawId;
    }
  })();

  const { userId, authorId, officialName, userName } = useAppStore();
  const currentAuthorId = authorId || deriveAuthorId(userId) || '';
  const currentAuthorName = resolveAuthorName(officialName, userName);
  const ownershipCtx = {
    currentAuthorId,
    currentUserId: userId,
    currentOfficialName: officialName,
    currentUserName: userName,
  };

  const [beneficiary, setBeneficiary] = useState<BeneficiaryDetailRecord | null>(null);
  const [reports, setReports] = useState<ReportSection[]>([]);
  const [allPhotosFlat, setAllPhotosFlat] = useState<PhotoRecord[]>([]);
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);
  const [imageRefreshKey, setImageRefreshKey] = useState(Date.now());

  const [editingReportId, setEditingReportId] = useState<string | null>(null);
  const [draftNoteText, setDraftNoteText] = useState('');
  const [isSharingProject, setIsSharingProject] = useState(false);

  const [permission, requestPermission] = useCameraPermissions();
  const [showCamera, setShowCamera] = useState(false);
  const [cameraRef, setCameraRef] = useState<CameraView | null>(null);
  const viewShotRef = useRef<ViewShot>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const [deviceOrientation, setDeviceOrientation] = useState(0);
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '4:3'>('4:3');
  const [flashMode, setFlashMode] = useState<'off' | 'on' | 'auto'>('auto');
  const [showZoom, setShowZoom] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(0);
  const zoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastZoomTap = useRef<number>(0);

  const [liveGeoData, setLiveGeoData] = useState<LiveGeoData | null>(null);
  const [captureQueue, setCaptureQueue] = useState<CaptureQueueItem[]>([]);
  const [captureTrigger, setCaptureTrigger] = useState(0);

  const [isCapturing, setIsCapturing] = useState(false);
  const isCapturingRef = useRef(false);

  const targetDir = getProjectDirectory(beneficiaryCode);
  const getDefaultNoteFilename = useCallback(
    (b: { serial_number?: string; name?: string } | null) =>
      generatePhotoFilename(b?.serial_number ?? '', b?.name ?? '', beneficiaryCode, 0).replace('.jpg', '_Notes.txt'),
    [beneficiaryCode]
  );

  const loadData = useCallback(async () => {
    try {
      const bData = await db.getFirstAsync<BeneficiaryDetailRecord>(
        `SELECT * FROM beneficiaries WHERE code = ?`,
        [beneficiaryCode]
      );
      setBeneficiary(bData);

      const reportRows = await db.getAllAsync<ReportRow>(
        `SELECT * FROM reports WHERE beneficiary_code = ? ORDER BY COALESCE(updated_at, created_at) DESC`,
        [beneficiaryCode]
      );

      const pData = await db.getAllAsync<PhotoRecord>(
        `SELECT * FROM photos WHERE beneficiary_code = ? ORDER BY created_at DESC`,
        [beneficiaryCode]
      );

      const meta = await readProjectMeta(targetDir);
      setProjectMeta(meta);

      // Read legacy flat note file if present
      let legacyNoteText = '';
      let legacyNoteFilename = getDefaultNoteFilename(bData);
      const resolvedNoteFile = new File(targetDir, legacyNoteFilename);
      if (resolvedNoteFile.exists) {
        legacyNoteText = await resolvedNoteFile.text();
      } else {
        const fallbackNoteFile = new File(targetDir, getDefaultNoteFilename(null));
        if (fallbackNoteFile.exists) {
          legacyNoteText = await fallbackNoteFile.text();
          legacyNoteFilename = fallbackNoteFile.name;
        } else if (targetDir.exists) {
          for (const entry of targetDir.list()) {
            if (!(entry instanceof Directory) && entry.name.endsWith('_Notes.txt')) {
              legacyNoteText = await entry.text();
              legacyNoteFilename = entry.name;
              break;
            }
          }
        }
      }

      const builtReports: ReportSection[] = [];
      const assignedPhotoIds = new Set<string>();

      for (const r of reportRows) {
        const rPhotos = pData.filter((p) => p.report_id === r.id);
        rPhotos.forEach((p) => assignedPhotoIds.add(p.id));

        let rNoteText = r.notes ?? '';
        const rNoteName = r.note_filename || getDefaultNoteFilename(bData);
        if (!rNoteText) {
          const rDir = getReportDirectory(beneficiaryCode, r.id);
          const rNoteFile = new File(rDir, rNoteName);
          if (rNoteFile.exists) {
            rNoteText = await rNoteFile.text();
          }
        }

        const rAuthorId = r.author_id?.trim() || '';
        const rAuthorName = r.author_name?.trim() || bData?.author_name?.trim() || meta?.authorName?.trim() || 'Field Agent';
        const isOwned = isOwnedByCurrentUser({ authorId: rAuthorId, authorName: rAuthorName }, ownershipCtx);

        builtReports.push({
          id: r.id,
          isLegacyRoot: false,
          authorId: rAuthorId,
          authorName: rAuthorName,
          originalAuthorId: r.original_author_id?.trim() || '',
          originalAuthorName: r.original_author_name?.trim() || '',
          isEditedCopy: Boolean(r.is_edited_copy),
          parentReportId: r.parent_report_id?.trim() || '',
          createdAt: r.created_at || '',
          updatedAt: r.updated_at || r.created_at || '',
          notes: rNoteText,
          noteFilename: rNoteName,
          photos: rPhotos,
          isOwnedByYou: isOwned,
        });
      }

      // Legacy flat photos or flat notes not yet attached to a report row
      const orphanPhotos = pData.filter((p) => !assignedPhotoIds.has(p.id));
      if (orphanPhotos.length > 0 || (reportRows.length === 0 && legacyNoteText.trim().length > 0)) {
        const legacyAuthorId =
          bData?.author_id?.trim() ||
          meta?.authorId?.trim() ||
          orphanPhotos[0]?.author_id?.trim() ||
          '';
        const legacyAuthorName =
          bData?.author_name?.trim() ||
          meta?.authorName?.trim() ||
          orphanPhotos[0]?.author_name?.trim() ||
          currentAuthorName;
        const earliestLegacyPhoto =
          orphanPhotos.length > 0 ? orphanPhotos[orphanPhotos.length - 1]?.created_at : null;
        const latestLegacyPhoto = orphanPhotos.length > 0 ? orphanPhotos[0]?.created_at : null;
        const legacyCreatedAt = meta?.createdAt || earliestLegacyPhoto || bData?.last_updated || '';
        const legacyUpdatedAt = latestLegacyPhoto || meta?.updatedAt || legacyCreatedAt;

        builtReports.push({
          id: 'legacy_root',
          isLegacyRoot: true,
          authorId: legacyAuthorId,
          authorName: legacyAuthorName,
          originalAuthorId: '',
          originalAuthorName: '',
          isEditedCopy: false,
          parentReportId: '',
          createdAt: legacyCreatedAt,
          updatedAt: legacyUpdatedAt,
          notes: legacyNoteText,
          noteFilename: legacyNoteFilename,
          photos: orphanPhotos,
          isOwnedByYou: isOwnedByCurrentUser(
            { authorId: legacyAuthorId, authorName: legacyAuthorName },
            ownershipCtx
          ),
        });
      }

      // Reverse chronological order: most recent report immediately below Beneficiary Details
      builtReports.sort((a, b) => {
        const bTime = parseSortMs(b.updatedAt || b.createdAt);
        const aTime = parseSortMs(a.updatedAt || a.createdAt);
        return bTime - aTime;
      });

      setReports(builtReports);
      setAllPhotosFlat(builtReports.flatMap((r) => r.photos));
    } catch {}
  }, [
    beneficiaryCode,
    currentAuthorId,
    currentAuthorName,
    db,
    getDefaultNoteFilename,
    officialName,
    targetDir,
    userId,
    userName,
  ]);

  useEffect(() => {
    loadData();
  }, [beneficiaryCode]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (editingReportId !== null) {
        setEditingReportId(null);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [editingReportId]);

  const handleBackPress = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/beneficiaries');
    }
  }, [router]);

  useEffect(() => {
    if (!showCamera) return;
    const subscription = Accelerometer.addListener(({ x, y }) => {
      if (Math.abs(x) > Math.abs(y)) setDeviceOrientation(x > 0 ? -90 : 90);
      else setDeviceOrientation(y > 0 ? 0 : 180);
    });
    Accelerometer.setUpdateInterval(300);
    return () => subscription.remove();
  }, [showCamera]);

  const findTargetLocalReport = (): ReportSection | null =>
    reports.find((r) => r.isOwnedByYou) || null;

  const saveNoteForReport = async (report: ReportSection | null) => {
    const trimmedNote = draftNoteText.trim();
    setEditingReportId(null);

    try {
      const nowIso = new Date().toISOString();
      const noteName = report?.noteFilename || getDefaultNoteFilename(beneficiary);

      if (report && report.isOwnedByYou && !report.isLegacyRoot) {
        // Update existing report owned by the local user
        const rDir = getReportDirectory(beneficiaryCode, report.id);
        rDir.create({ intermediates: true, idempotent: true });
        new File(rDir, noteName).write(trimmedNote);

        await db.runAsync(
          `UPDATE reports SET notes = ?, note_filename = ?, updated_at = ? WHERE id = ?`,
          [trimmedNote, noteName, nowIso, report.id]
        );
        await writeReportMeta(rDir, {
          reportId: report.id,
          beneficiaryCode,
          authorId: currentAuthorId || undefined,
          authorName: currentAuthorName,
          originalAuthorId: report.originalAuthorId || undefined,
          originalAuthorName: report.originalAuthorName || undefined,
          isEditedCopy: report.isEditedCopy,
          parentReportId: report.parentReportId || undefined,
          createdAt: report.createdAt || nowIso,
          updatedAt: nowIso,
        });
      } else if (report && report.isOwnedByYou && report.isLegacyRoot) {
        // Update legacy flat note owned by local user
        targetDir.create({ intermediates: true, idempotent: true });
        new File(targetDir, noteName).write(trimmedNote);
        await writeProjectMeta(targetDir, {
          beneficiaryCode,
          originalCode: beneficiary?.original_code || beneficiaryCode,
          authorId: currentAuthorId || undefined,
          authorName: currentAuthorName,
          createdAt: projectMeta?.createdAt || report.createdAt || nowIso,
          updatedAt: nowIso,
          preserveExistingOwner: true,
        });
      } else {
        // Either brand-new note OR editing an imported report -> create a NEW report subdirectory
        // Never mutate the original imported report or its creator metadata
        const newReportId = generateReportId(beneficiaryCode);
        const newReportDir = getReportDirectory(beneficiaryCode, newReportId);
        newReportDir.create({ intermediates: true, idempotent: true });
        new File(newReportDir, noteName).write(trimmedNote);

        const isEditingImported = Boolean(report && !report.isOwnedByYou);
        const origAuthorId = isEditingImported ? (report?.originalAuthorId || report?.authorId || '') : '';
        const origAuthorName = isEditingImported ? (report?.originalAuthorName || report?.authorName || '') : '';
        const parentId = isEditingImported ? (report?.id || '') : '';

        await db.runAsync(
          `INSERT INTO reports (
            id, beneficiary_code, author_id, author_name,
            original_author_id, original_author_name,
            notes, note_filename, is_edited_copy, parent_report_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newReportId,
            beneficiaryCode,
            currentAuthorId || null,
            currentAuthorName,
            origAuthorId || null,
            origAuthorName || null,
            trimmedNote,
            noteName,
            isEditingImported ? 1 : 0,
            parentId || null,
            nowIso,
            nowIso,
          ]
        );

        await writeReportMeta(newReportDir, {
          reportId: newReportId,
          beneficiaryCode,
          authorId: currentAuthorId || undefined,
          authorName: currentAuthorName,
          originalAuthorId: origAuthorId || undefined,
          originalAuthorName: origAuthorName || undefined,
          isEditedCopy: isEditingImported,
          parentReportId: parentId || undefined,
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        await db.runAsync(
          `UPDATE beneficiaries
           SET author_id = COALESCE(NULLIF(TRIM(author_id), ''), ?),
               author_name = COALESCE(NULLIF(TRIM(author_name), ''), ?),
               last_updated = CURRENT_TIMESTAMP
           WHERE code = ?`,
          [currentAuthorId || null, currentAuthorName, beneficiaryCode]
        );

        await writeProjectMeta(targetDir, {
          beneficiaryCode,
          originalCode: beneficiary?.original_code || beneficiaryCode,
          authorId: currentAuthorId || undefined,
          authorName: currentAuthorName,
          createdAt: projectMeta?.createdAt || nowIso,
          updatedAt: nowIso,
          preserveExistingOwner: true,
        });
      }

      await loadData();
    } catch {
      Alert.alert("Error", "Could not save notes.");
    }
  };

  const processLocationUpdate = async (loc: Location.LocationObject) => {
    try {
      const geocode = await Location.reverseGeocodeAsync({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      });
      const addr = geocode[0] || {};

      let shortLoc = [addr.city || addr.subregion, addr.region, addr.country].filter(Boolean).join(', ');
      if (!shortLoc.includes('🇮🇳')) shortLoc += ' 🇮🇳';

      const detailedAddress = [addr.name, addr.street, addr.subregion || addr.city, addr.region, addr.postalCode, addr.country]
        .filter(Boolean)
        .join(', ');

      setLiveGeoData({
        lat: loc.coords.latitude.toFixed(6),
        lon: loc.coords.longitude.toFixed(6),
        address: detailedAddress || 'Unknown Location',
        shortLocation: shortLoc,
        timestamp: formatGeoDate(new Date(loc.timestamp)),
      });
    } catch {}
  };

  useEffect(() => {
    let sub: Location.LocationSubscription | undefined;
    if (showCamera) {
      (async () => {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const lastKnown = await Location.getLastKnownPositionAsync();
          if (lastKnown) processLocationUpdate(lastKnown);
          else {
            const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
            if (current) processLocationUpdate(current);
          }

          sub = await Location.watchPositionAsync(
            { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 2 },
            processLocationUpdate
          );
        }
      })();
    }
    return () => {
      if (sub) sub.remove();
    };
  }, [showCamera]);

  const openCamera = async () => {
    if (!permission?.granted) await requestPermission();
    await Location.requestForegroundPermissionsAsync();
    setZoomIndex(0);
    setShowCamera(true);
  };

  const captureLiveMedia = async () => {
    if (!cameraRef || isCapturingRef.current) return;
    try {
      isCapturingRef.current = true;
      setIsCapturing(true);
      const photo = await cameraRef.takePictureAsync({ quality: 1, skipProcessing: true });
      if (!photo) return;
      const currentGeo: LiveGeoData = liveGeoData || {
        lat: '0.000000',
        lon: '0.000000',
        address: 'Locating...',
        shortLocation: 'Locating... 🇮🇳',
        timestamp: formatGeoDate(new Date()),
      };

      setCaptureQueue((q) => [
        ...q,
        {
          id: Date.now(),
          uri: photo.uri,
          geoData: { ...currentGeo, timestamp: formatGeoDate(new Date()) },
          orientation: deviceOrientation,
          aspectRatio,
        },
      ]);
      setShowCamera(false);
    } catch {
    } finally {
      setTimeout(() => {
        isCapturingRef.current = false;
        setIsCapturing(false);
      }, 1500);
    }
  };

  useEffect(() => {
    if (captureTrigger > 0 && captureQueue.length > 0 && viewShotRef.current) {
      setTimeout(async () => {
        try {
          const stampedUri = await viewShotRef.current?.capture?.();
          if (stampedUri) {
            const nowIso = new Date().toISOString();
            const existingLocalReport = findTargetLocalReport();
            let targetReportId: string;
            let destReportDir: Directory;

            if (existingLocalReport && !existingLocalReport.isLegacyRoot) {
              targetReportId = existingLocalReport.id;
              destReportDir = getReportDirectory(beneficiaryCode, targetReportId);
              await db.runAsync(`UPDATE reports SET updated_at = ? WHERE id = ?`, [nowIso, targetReportId]);
              await writeReportMeta(destReportDir, {
                reportId: targetReportId,
                beneficiaryCode,
                authorId: currentAuthorId || undefined,
                authorName: currentAuthorName,
                originalAuthorId: existingLocalReport.originalAuthorId || undefined,
                originalAuthorName: existingLocalReport.originalAuthorName || undefined,
                isEditedCopy: existingLocalReport.isEditedCopy,
                parentReportId: existingLocalReport.parentReportId || undefined,
                createdAt: existingLocalReport.createdAt || nowIso,
                updatedAt: nowIso,
              });
            } else if (existingLocalReport && existingLocalReport.isLegacyRoot) {
              // Keep legacy flat root directory for existing local legacy report
              targetReportId = '';
              destReportDir = targetDir;
            } else {
              // Brand-new inspection OR adding photos to an imported project -> create isolated subdirectory
              targetReportId = generateReportId(beneficiaryCode);
              destReportDir = getReportDirectory(beneficiaryCode, targetReportId);
              const latestImported = reports.find((r) => !r.isOwnedByYou) || null;
              const isEditedCopy = Boolean(latestImported);

              await db.runAsync(
                `INSERT INTO reports (
                  id, beneficiary_code, author_id, author_name,
                  original_author_id, original_author_name,
                  notes, note_filename, is_edited_copy, parent_report_id,
                  created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  targetReportId,
                  beneficiaryCode,
                  currentAuthorId || null,
                  currentAuthorName,
                  latestImported?.originalAuthorId || latestImported?.authorId || null,
                  latestImported?.originalAuthorName || latestImported?.authorName || null,
                  null,
                  getDefaultNoteFilename(beneficiary),
                  isEditedCopy ? 1 : 0,
                  latestImported?.id || null,
                  nowIso,
                  nowIso,
                ]
              );

              await writeReportMeta(destReportDir, {
                reportId: targetReportId,
                beneficiaryCode,
                authorId: currentAuthorId || undefined,
                authorName: currentAuthorName,
                originalAuthorId: latestImported?.originalAuthorId || latestImported?.authorId || undefined,
                originalAuthorName: latestImported?.originalAuthorName || latestImported?.authorName || undefined,
                isEditedCopy,
                parentReportId: latestImported?.id || undefined,
                createdAt: nowIso,
                updatedAt: nowIso,
              });
            }

            destReportDir.create({ intermediates: true, idempotent: true });
            let photoIdx = existingLocalReport ? existingLocalReport.photos.length : 0;
            let filename = generatePhotoFilename(
              beneficiary?.serial_number ?? '',
              beneficiary?.name ?? '',
              beneficiaryCode,
              photoIdx
            );
            let destPhoto = new File(destReportDir, filename);
            while (destPhoto.exists) {
              photoIdx += 1;
              filename = generatePhotoFilename(
                beneficiary?.serial_number ?? '',
                beneficiary?.name ?? '',
                beneficiaryCode,
                photoIdx
              );
              destPhoto = new File(destReportDir, filename);
            }
            new File(stampedUri).copy(destPhoto);
            const newUri = destPhoto.uri;

            await db.runAsync(
              `INSERT INTO photos (id, beneficiary_code, report_id, local_uri, filename, latitude, longitude, author_id, author_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                captureQueue[0].id.toString(),
                beneficiaryCode,
                targetReportId || null,
                newUri,
                filename,
                captureQueue[0].geoData.lat,
                captureQueue[0].geoData.lon,
                currentAuthorId || null,
                currentAuthorName,
              ]
            );

            await db.runAsync(
              `UPDATE beneficiaries
               SET author_id = COALESCE(NULLIF(TRIM(author_id), ''), ?),
                   author_name = COALESCE(NULLIF(TRIM(author_name), ''), ?),
                   last_updated = CURRENT_TIMESTAMP
               WHERE code = ?`,
              [currentAuthorId || null, currentAuthorName, beneficiaryCode]
            );

            await writeProjectMeta(targetDir, {
              beneficiaryCode,
              originalCode: beneficiary?.original_code || beneficiaryCode,
              authorId: currentAuthorId || undefined,
              authorName: currentAuthorName,
              createdAt: projectMeta?.createdAt || beneficiary?.last_updated || nowIso,
              updatedAt: nowIso,
              preserveExistingOwner: true,
            });

            setImageRefreshKey(Date.now());
            loadData();
          }
        } catch {} finally {
          setCaptureQueue((q) => q.slice(1));
          setCaptureTrigger(0);
        }
      }, 200);
    }
  }, [captureTrigger, captureQueue]);

  const handleShareSinglePhoto = async (photo: PhotoRecord) => {
    try {
      const cleanUri = photo.local_uri.split('?')[0];
      const file = new File(cleanUri);
      if (!file.exists) {
        Alert.alert('File Not Found', 'This photo file could not be found on disk.');
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: 'image/jpeg',
        dialogTitle: 'Share Inspection Photo',
      });
    } catch {
      Alert.alert('Share Failed', 'Could not share this photo.');
    }
  };

  const handleShareWholeProject = async () => {
    if (isSharingProject) return;
    const hasNotes = reports.some((r) => Boolean(r.notes && r.notes.trim().length > 0));
    if (allPhotosFlat.length === 0 && !hasNotes) {
      Alert.alert(
        'Nothing to Share',
        'There are no photos, notes, or reports in this project to share.'
      );
      return;
    }
    setIsSharingProject(true);
    try {
      const zipUri = await shareProjectsZipArchive(db, [
        { code: beneficiaryCode, name: beneficiary?.name || beneficiaryCode },
      ]);
      setIsSharingProject(false);
      if (!zipUri) {
        Alert.alert(
          'Nothing to Share',
          'There are no photos, notes, or reports in this project to share.'
        );
        return;
      }
      await Sharing.shareAsync(zipUri, {
        mimeType: 'application/zip',
        dialogTitle: `Share ${beneficiary?.name || beneficiaryCode}`,
      });
    } catch {
      setIsSharingProject(false);
      Alert.alert('Share Failed', 'Could not package project photos and notes for sharing.');
    }
  };

  const handleZoomTap = () => {
    const now = Date.now();
    if (now - lastZoomTap.current < 300) {
      setZoomIndex(0);
      setShowZoom(false);
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    } else {
      setShowZoom(!showZoom);
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
      if (!showZoom) zoomTimeoutRef.current = setTimeout(() => setShowZoom(false), 3000);
    }
    lastZoomTap.current = now;
  };

  const changeZoom = (delta: number) => {
    setZoomIndex((z) => Math.max(0, Math.min(ZOOM_STEPS.length - 1, z + delta)));
    if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    zoomTimeoutRef.current = setTimeout(() => setShowZoom(false), 3000);
  };

  const deletePhoto = async (photoId: string, uri: string) => {
    Alert.alert("Delete Photo", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            const photoFile = new File(uri.split('?')[0]);
            if (photoFile.exists) {
              photoFile.delete();
            }
            await db.runAsync(`DELETE FROM photos WHERE id = ?`, [photoId]);
            setViewerIndex(null);
            loadData();
          } catch {}
        },
      },
    ]);
  };

  const rotatePhoto = async (photo: PhotoRecord, direction: 'left' | 'right') => {
    try {
      const cleanUri = photo.local_uri.split('?')[0];
      const angle = direction === 'right' ? 90 : -90;
      const manipResult = await ImageManipulator.manipulateAsync(
        cleanUri,
        [{ rotate: angle }],
        { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
      );
      const destPhoto = new File(cleanUri);
      if (destPhoto.exists) {
        destPhoto.delete();
      }
      new File(manipResult.uri).copy(destPhoto);
      setImageRefreshKey(Date.now());
    } catch {
      Alert.alert("Error", "Could not rotate.");
    }
  };

  const viewerPhoto = viewerIndex !== null ? allPhotosFlat[viewerIndex] : null;
  const viewerPhotoOwnedByYou = viewerPhoto
    ? isOwnedByCurrentUser(
        {
          authorId: viewerPhoto.author_id,
          authorName: viewerPhoto.author_name || beneficiary?.author_name,
        },
        ownershipCtx
      )
    : false;

  const CAMERA_HEIGHT = aspectRatio === '4:3' ? SCREEN_WIDTH * (4 / 3) : SCREEN_WIDTH * (16 / 9);
  const isLandscapeMode = deviceOrientation === 90 || deviceOrientation === -90;
  const overlayContainerWidth = isLandscapeMode ? CAMERA_HEIGHT : SCREEN_WIDTH;
  const overlayContainerHeight = isLandscapeMode ? SCREEN_WIDTH : CAMERA_HEIGHT;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      {captureQueue.length > 0 && (
        <View style={{ position: 'absolute', top: 0, left: 0, zIndex: -100, opacity: 0.01 }} pointerEvents="none" collapsable={false}>
          {(() => {
            const item = captureQueue[0];
            const isLandscape = item.orientation === 90 || item.orientation === -90;
            const shotW = isLandscape ? 1440 : 1080;
            const shotH = isLandscape ? 1080 : 1440;
            const scaleRatio = shotW / SCREEN_WIDTH;

            return (
              <ViewShot ref={viewShotRef} options={{ format: 'jpg', quality: 0.9 }} style={{ width: shotW, height: shotH, backgroundColor: '#000' }}>
                <Image source={{ uri: item.uri }} style={{ width: '100%', height: '100%', resizeMode: 'cover' }} onLoad={() => setCaptureTrigger(Date.now())} />
                <View style={{ position: 'absolute', bottom: 4 * scaleRatio, left: 4 * scaleRatio, right: 4 * scaleRatio }} collapsable={false}>
                  <GPSCameraOverlay geoData={item.geoData} sizeRatio={scaleRatio} isLive={false} />
                </View>
              </ViewShot>
            );
          })()}
        </View>
      )}

      <View style={[styles.appBar, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={handleBackPress} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={24} color="#1E293B" />
        </TouchableOpacity>
        <Text style={styles.appBarTitle}>Beneficiary Details</Text>
        <TouchableOpacity
          onPress={handleShareWholeProject}
          style={styles.appBarShareBtn}
          disabled={isSharingProject}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          {isSharingProject ? (
            <ActivityIndicator size="small" color="#2563EB" />
          ) : (
            <Ionicons name="share-social-outline" size={22} color="#2563EB" />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
        {/* Top Beneficiary Details Section (no avatar icon; ID first, then Name; City above District) */}
        <View style={styles.detailsCard}>
          <View style={styles.detailsHeaderNoAvatar}>
            <Text style={styles.beneficiaryCode} numberOfLines={1} adjustsFontSizeToFit>
              ID: {beneficiary?.original_code || beneficiaryCode}
            </Text>
            <Text style={styles.beneficiaryName}>
              {toTitleCase(beneficiary?.name) || 'Name not provided'}
            </Text>
          </View>

          <View style={styles.divider} />

          <DetailRow label="Annexure ID" value={beneficiary?.annexure_id} />
          <DetailRow label="Project Name" value={beneficiary?.project_name} />
          <DetailRow label="Father's Name" value={beneficiary?.father_name} />
          <DetailRow label="City" value={beneficiary?.city_name} />
          <DetailRow label="District" value={beneficiary?.district_name} />
          <DetailRow label="Site Address" value={beneficiary?.site_address} />

          <View style={styles.divider} />

          <View style={styles.detailsGrid}>
            <View style={styles.detailItem}>
              <Text style={styles.gridLabel}>Photos</Text>
              <Text style={styles.gridValue}>{allPhotosFlat.length}</Text>
            </View>
            <View style={styles.detailItem}>
              <Text style={styles.gridLabel}>Reports</Text>
              <Text style={styles.gridValue}>{reports.length}</Text>
            </View>
            <View style={styles.detailItem}>
              <Text style={styles.gridLabel}>Sync Status</Text>
              <Text style={[styles.gridValue, { color: beneficiary?.sync_status === 'synced' ? '#10B981' : '#F59E0B' }]}>
                {beneficiary?.sync_status === 'synced' ? 'Synced' : 'Draft'}
              </Text>
            </View>
          </View>
        </View>

        {/* Reports in reverse chronological order */}
        {reports.length === 0 ? (
          <View style={styles.reportCard}>
            <Text style={styles.sectionTitle}>Geo-captured Images (0)</Text>
            <View style={styles.emptyContainer}>
              <Ionicons name="images-outline" size={44} color="#CBD5E1" />
              <Text style={styles.emptyText}>No geotagged photos taken yet.</Text>
            </View>

            <View style={styles.sectionDivider} />

            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Inspection Notes</Text>
              {editingReportId !== 'new_draft' && (
                <TouchableOpacity
                  onPress={() => {
                    setDraftNoteText('');
                    setEditingReportId('new_draft');
                  }}
                  style={styles.editNoteIcon}
                >
                  <Ionicons name="pencil" size={18} color="#2563EB" />
                </TouchableOpacity>
              )}
            </View>

            {editingReportId === 'new_draft' ? (
              <View>
                <TextInput
                  style={styles.notesInputActive}
                  placeholder="Add site observations, status, or issues here..."
                  placeholderTextColor="#94A3B8"
                  multiline
                  autoFocus
                  value={draftNoteText}
                  onChangeText={setDraftNoteText}
                  textAlignVertical="top"
                />
                <View style={styles.noteEditBtnRow}>
                  <TouchableOpacity style={styles.cancelNoteBtn} onPress={() => setEditingReportId(null)}>
                    <Text style={styles.cancelNoteText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.saveNoteBtn} onPress={() => saveNoteForReport(null)}>
                    <Text style={styles.saveNoteText}>Save Note</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.notesInput, { justifyContent: 'center' }]}
                onLongPress={() => {
                  setDraftNoteText('');
                  setEditingReportId('new_draft');
                }}
                activeOpacity={0.7}
              >
                <Text style={{ color: '#94A3B8', fontStyle: 'italic', lineHeight: 22 }}>
                  No saved notes found yet. Tap the pen icon to add.
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.sectionDivider} />

            <View style={styles.authorInfoBlock}>
              <View style={styles.authorInfoRow}>
                <View style={styles.authorIconBadge}>
                  <Ionicons name="shield-checkmark-outline" size={18} color="#2563EB" />
                </View>
                <View style={styles.authorInfoTextCol}>
                  <Text style={styles.authorInfoLabel}>Reporting Agent / Author</Text>
                  <Text style={styles.authorInfoValue}>{currentAuthorName}</Text>
                </View>
              </View>
              <View style={styles.authorInfoDivider} />
              <View style={styles.authorInfoRow}>
                <View style={[styles.authorIconBadge, { backgroundColor: '#F0FDF4' }]}>
                  <Ionicons name="time-outline" size={18} color="#059669" />
                </View>
                <View style={styles.authorInfoTextCol}>
                  <Text style={styles.authorInfoLabel}>Original Date & Time</Text>
                  <Text style={styles.authorInfoValue}>Not recorded yet</Text>
                </View>
              </View>
            </View>
          </View>
        ) : (
          reports.map((report, rIdx) => {
            const isEditingThis = editingReportId === report.id;
            const showEditedAttribution = Boolean(report.isEditedCopy && report.originalAuthorName);

            return (
              <View key={report.id} style={styles.reportCard}>
                <View style={styles.reportTopBadgeRow}>
                  <Text style={styles.reportBadgeTitle}>
                    {reports.length > 1 ? `Report #${reports.length - rIdx}` : 'Inspection Report'}
                  </Text>
                  <View style={[styles.reportOwnerPill, report.isOwnedByYou ? styles.pillYou : styles.pillImported]}>
                    <Text style={[styles.reportOwnerPillText, report.isOwnedByYou ? styles.pillTextYou : styles.pillTextImported]}>
                      {report.isOwnedByYou ? 'You' : 'Imported'}
                    </Text>
                  </View>
                </View>

                {/* 1. Geo-captured Images */}
                <Text style={[styles.sectionTitle, { marginBottom: 10 }]}>
                  Geo-captured Images ({report.photos.length})
                </Text>
                {report.photos.length === 0 ? (
                  <View style={styles.emptyReportPhotos}>
                    <Ionicons name="images-outline" size={32} color="#CBD5E1" />
                    <Text style={styles.emptyReportPhotosText}>No photos in this report.</Text>
                  </View>
                ) : (
                  <View style={styles.photoGrid}>
                    {report.photos.map((photo) => {
                      const flatIdx = allPhotosFlat.findIndex((p) => p.id === photo.id);
                      return (
                        <TouchableOpacity
                          key={photo.id}
                          style={styles.imageWrapper}
                          activeOpacity={0.9}
                          onPress={() => {
                            setViewerIndex(flatIdx >= 0 ? flatIdx : 0);
                          }}
                        >
                          <Image
                            source={{ uri: `${photo.local_uri.split('?')[0]}?v=${imageRefreshKey}` }}
                            style={styles.thumbnail}
                          />
                          <TouchableOpacity
                            style={styles.photoShareBtn}
                            onPress={(e) => {
                              e.stopPropagation();
                              handleShareSinglePhoto(photo);
                            }}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          >
                            <Ionicons name="share-social" size={14} color="#FFFFFF" />
                          </TouchableOpacity>
                          <View style={styles.geoBadge}>
                            <Ionicons name="location" size={10} color="#FFF" />
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}

                <View style={styles.sectionDivider} />

                {/* 2. Inspection Notes */}
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionTitle}>Inspection Notes</Text>
                  {!isEditingThis && (
                    <TouchableOpacity
                      onPress={() => {
                        setDraftNoteText(report.notes || '');
                        setEditingReportId(report.id);
                      }}
                      style={styles.editNoteIcon}
                    >
                      <Ionicons name="pencil" size={18} color="#2563EB" />
                    </TouchableOpacity>
                  )}
                </View>

                {isEditingThis ? (
                  <View>
                    {!report.isOwnedByYou && (
                      <Text style={styles.immutableEditNotice}>
                        Editing an imported report will save a separate edited report while keeping the original intact.
                      </Text>
                    )}
                    <TextInput
                      style={styles.notesInputActive}
                      placeholder="Add site observations, status, or issues here..."
                      placeholderTextColor="#94A3B8"
                      multiline
                      autoFocus
                      value={draftNoteText}
                      onChangeText={setDraftNoteText}
                      textAlignVertical="top"
                    />
                    <View style={styles.noteEditBtnRow}>
                      <TouchableOpacity style={styles.cancelNoteBtn} onPress={() => setEditingReportId(null)}>
                        <Text style={styles.cancelNoteText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.saveNoteBtn} onPress={() => saveNoteForReport(report)}>
                        <Text style={styles.saveNoteText}>Save Note</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.notesInput, { justifyContent: report.notes ? 'flex-start' : 'center' }]}
                    onLongPress={() => {
                      setDraftNoteText(report.notes || '');
                      setEditingReportId(report.id);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={{
                        color: report.notes ? '#1E293B' : '#94A3B8',
                        fontStyle: report.notes ? 'normal' : 'italic',
                        lineHeight: 22,
                      }}
                    >
                      {report.notes || 'No saved notes found yet. Tap the pen icon to add.'}
                    </Text>
                  </TouchableOpacity>
                )}

                <View style={styles.sectionDivider} />

                {/* 3. Reporting Agent Metadata */}
                <View style={styles.authorInfoBlock}>
                  {showEditedAttribution ? (
                    <>
                      <View style={styles.authorInfoRow}>
                        <View style={styles.authorIconBadge}>
                          <Ionicons name="shield-checkmark-outline" size={18} color="#2563EB" />
                        </View>
                        <View style={styles.authorInfoTextCol}>
                          <Text style={styles.authorInfoLabel}>Original Reporting Author</Text>
                          <Text style={styles.authorInfoValue}>{report.originalAuthorName}</Text>
                        </View>
                      </View>
                      <View style={styles.authorInfoDivider} />
                      <View style={styles.authorInfoRow}>
                        <View style={[styles.authorIconBadge, { backgroundColor: '#FEF3C7' }]}>
                          <Ionicons name="create-outline" size={18} color="#B45309" />
                        </View>
                        <View style={styles.authorInfoTextCol}>
                          <Text style={styles.authorInfoLabel}>
                            Edited Date & Time ({report.authorName})
                          </Text>
                          <Text style={styles.authorInfoValue}>
                            {formatDisplayDateTime(report.updatedAt || report.createdAt)}
                          </Text>
                        </View>
                      </View>
                    </>
                  ) : (
                    <>
                      <View style={styles.authorInfoRow}>
                        <View style={styles.authorIconBadge}>
                          <Ionicons name="shield-checkmark-outline" size={18} color="#2563EB" />
                        </View>
                        <View style={styles.authorInfoTextCol}>
                          <Text style={styles.authorInfoLabel}>Reporting Agent / Author</Text>
                          <Text style={styles.authorInfoValue}>{report.authorName}</Text>
                        </View>
                      </View>
                      <View style={styles.authorInfoDivider} />
                      <View style={styles.authorInfoRow}>
                        <View style={[styles.authorIconBadge, { backgroundColor: '#F0FDF4' }]}>
                          <Ionicons name="time-outline" size={18} color="#059669" />
                        </View>
                        <View style={styles.authorInfoTextCol}>
                          <Text style={styles.authorInfoLabel}>Original Date & Time</Text>
                          <Text style={styles.authorInfoValue}>
                            {formatDisplayDateTime(report.createdAt || report.updatedAt)}
                          </Text>
                        </View>
                      </View>
                    </>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      <View style={[styles.fabContainer, { bottom: 30 + insets.bottom }]}>
        <TouchableOpacity style={styles.fab} onPress={openCamera}>
          <Ionicons name="camera" size={28} color="#FFF" />
        </TouchableOpacity>
      </View>

      <Modal visible={showCamera} transparent animationType="slide" onRequestClose={() => setShowCamera(false)}>
        <View style={styles.cameraContainer}>
          <View style={{ flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
            <View style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT, overflow: 'hidden' }}>
              <CameraView
                ref={setCameraRef}
                style={{ width: '100%', height: '100%' }}
                zoom={ZOOM_STEPS[zoomIndex]}
                facing="back"
                flash={flashMode === 'auto' ? 'auto' : flashMode === 'on' ? 'on' : 'off'}
                ratio={aspectRatio}
              />

              {(!liveGeoData || liveGeoData.lat === '0.000000') && (
                <View style={styles.gpsWaitingOverlay}>
                  <ActivityIndicator size="small" color="#FFF" />
                  <Text style={{ color: '#FFF', marginLeft: 8, fontWeight: 'bold' }}>Acquiring GPS...</Text>
                </View>
              )}

              {liveGeoData && (
                <View
                  style={{
                    position: 'absolute',
                    width: overlayContainerWidth,
                    height: overlayContainerHeight,
                    top: (CAMERA_HEIGHT - overlayContainerHeight) / 2,
                    left: (SCREEN_WIDTH - overlayContainerWidth) / 2,
                    justifyContent: 'flex-end',
                    paddingBottom: 4,
                    paddingHorizontal: 4,
                    transform: [{ rotate: `${-deviceOrientation}deg` }],
                    pointerEvents: 'none',
                  }}
                >
                  <GPSCameraOverlay geoData={liveGeoData} sizeRatio={1} isLive={true} />
                </View>
              )}
            </View>
          </View>

          <View
            style={{
              position: 'absolute',
              top: 60,
              left: 0,
              right: 0,
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'flex-start',
              gap: 20,
              zIndex: 30,
            }}
            pointerEvents="box-none"
          >
            <TouchableOpacity onPress={() => setAspectRatio((a) => (a === '16:9' ? '4:3' : '16:9'))} style={styles.cameraTopBtn}>
              <Ionicons name="expand" size={24} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
              <Text style={[styles.cameraTopBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>{aspectRatio}</Text>
            </TouchableOpacity>

            <View style={{ alignItems: 'center' }} pointerEvents="box-none">
              <TouchableOpacity onPress={handleZoomTap} style={[styles.cameraTopBtn, showZoom && { backgroundColor: 'rgba(255,255,255,0.3)' }]}>
                <Ionicons name="search" size={24} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
                <Text style={[styles.cameraTopBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>{ZOOM_LABELS[zoomIndex]}</Text>
              </TouchableOpacity>
              {showZoom && (
                <View style={styles.zoomControls}>
                  <TouchableOpacity onPress={() => changeZoom(-1)} style={styles.zoomBtnIndividual}>
                    <Text style={[styles.zoomBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>-</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => changeZoom(1)} style={styles.zoomBtnIndividual}>
                    <Text style={[styles.zoomBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>+</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            <TouchableOpacity onPress={() => setFlashMode((f) => (f === 'auto' ? 'off' : f === 'off' ? 'on' : 'auto'))} style={styles.cameraTopBtn}>
              <Ionicons
                name={flashMode === 'on' ? 'flash' : flashMode === 'auto' ? 'flash-outline' : 'flash-off'}
                size={24}
                color="#FFF"
                style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }}
              />
              <Text style={[styles.cameraTopBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>{flashMode}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.cameraControlsContainer} pointerEvents="box-none">
            <TouchableOpacity onPress={() => setShowCamera(false)} style={styles.cameraSideBtn}>
              <Ionicons name="close" size={36} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={captureLiveMedia}
              disabled={isCapturing}
              style={[styles.cameraCaptureBtnOuter, isCapturing && { borderColor: '#94A3B8' }]}
            >
              <View style={[styles.cameraCaptureBtnInner, isCapturing && { backgroundColor: '#E2E8F0' }]} />
            </TouchableOpacity>

            <View style={{ width: 50 }} />
          </View>
        </View>
      </Modal>

      <Modal visible={viewerIndex !== null} transparent animationType="fade" onRequestClose={() => setViewerIndex(null)}>
        <View style={styles.viewerContainer}>
          <View style={styles.viewerHeader}>
            {viewerPhoto && (
              <TouchableOpacity style={styles.viewerActionBtn} onPress={() => handleShareSinglePhoto(viewerPhoto)}>
                <Ionicons name="share-social-outline" size={24} color="#FFF" />
              </TouchableOpacity>
            )}
            {viewerPhoto && viewerPhotoOwnedByYou && (
              <>
                <TouchableOpacity style={styles.viewerActionBtn} onPress={() => rotatePhoto(viewerPhoto, 'left')}>
                  <MaterialIcons name="rotate-left" size={26} color="#FFF" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.viewerActionBtn} onPress={() => rotatePhoto(viewerPhoto, 'right')}>
                  <MaterialIcons name="rotate-right" size={26} color="#FFF" />
                </TouchableOpacity>
                <TouchableOpacity style={styles.viewerActionBtn} onPress={() => deletePhoto(viewerPhoto.id, viewerPhoto.local_uri)}>
                  <Ionicons name="trash" size={24} color="#EF4444" />
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity style={[styles.viewerActionBtn, { marginLeft: 8 }]} onPress={() => setViewerIndex(null)}>
              <Ionicons name="close" size={30} color="#FFF" />
            </TouchableOpacity>
          </View>

          <View style={{ flex: 1, width: '100%', justifyContent: 'center' }}>
            {viewerPhoto && (
              <ZoomableImage
                uri={`${viewerPhoto.local_uri.split('?')[0]}?v=${imageRefreshKey}`}
                onSwipePrev={
                  viewerIndex !== null && viewerIndex > 0
                    ? () => setViewerIndex(viewerIndex - 1)
                    : undefined
                }
                onSwipeNext={
                  viewerIndex !== null && viewerIndex < allPhotosFlat.length - 1
                    ? () => setViewerIndex(viewerIndex + 1)
                    : undefined
                }
              />
            )}

            {viewerIndex !== null && viewerIndex > 0 && (
              <TouchableOpacity style={styles.swipeLeftBtn} onPress={() => setViewerIndex(viewerIndex - 1)}>
                <Ionicons name="chevron-back" size={32} color="#FFF" />
              </TouchableOpacity>
            )}

            {viewerIndex !== null && viewerIndex < allPhotosFlat.length - 1 && (
              <TouchableOpacity style={styles.swipeRightBtn} onPress={() => setViewerIndex(viewerIndex + 1)}>
                <Ionicons name="chevron-forward" size={32} color="#FFF" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const clampValue = (val: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, val));

interface ZoomableImageProps {
  uri: string;
  onSwipePrev?: () => void;
  onSwipeNext?: () => void;
}

const ZoomableImage = ({ uri, onSwipePrev, onSwipeNext }: ZoomableImageProps) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const txAnim = useRef(new Animated.Value(0)).current;
  const tyAnim = useRef(new Animated.Value(0)).current;

  const scaleRef = useRef(1);
  const txRef = useRef(0);
  const tyRef = useRef(0);

  const gestureModeRef = useRef<'idle' | 'pan' | 'pinch'>('idle');
  const pinchStartDistRef = useRef(1);
  const pinchStartScaleRef = useRef(1);
  const pinchStartCenterRef = useRef({ x: 0, y: 0 });
  const pinchStartTxRef = useRef(0);
  const pinchStartTyRef = useRef(0);

  const panStartTxRef = useRef(0);
  const panStartTyRef = useRef(0);
  const panDxOffsetRef = useRef(0);
  const panDyOffsetRef = useRef(0);
  const hasMovedRef = useRef(false);

  const lastTapTimeRef = useRef(0);
  const lastTapPosRef = useRef({ x: 0, y: 0 });

  const onSwipePrevRef = useRef(onSwipePrev);
  const onSwipeNextRef = useRef(onSwipeNext);
  onSwipePrevRef.current = onSwipePrev;
  onSwipeNextRef.current = onSwipeNext;

  const getBounds = (scale: number) => ({
    maxX: Math.max(0, (SCREEN_WIDTH * (scale - 1)) / 2),
    maxY: Math.max(0, (SCREEN_HEIGHT * (scale - 1)) / 2),
  });

  const animateTo = useCallback(
    (nextScale: number, nextTx: number, nextTy: number, animate = true) => {
      const { maxX, maxY } = getBounds(nextScale);
      const clampedTx = clampValue(nextTx, -maxX, maxX);
      const clampedTy = clampValue(nextTy, -maxY, maxY);

      scaleRef.current = nextScale;
      txRef.current = clampedTx;
      tyRef.current = clampedTy;

      if (!animate) {
        scaleAnim.setValue(nextScale);
        txAnim.setValue(clampedTx);
        tyAnim.setValue(clampedTy);
        return;
      }

      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: nextScale,
          useNativeDriver: true,
          friction: 7,
          tension: 70,
        }),
        Animated.spring(txAnim, {
          toValue: clampedTx,
          useNativeDriver: true,
          friction: 7,
          tension: 70,
        }),
        Animated.spring(tyAnim, {
          toValue: clampedTy,
          useNativeDriver: true,
          friction: 7,
          tension: 70,
        }),
      ]).start();
    },
    [scaleAnim, txAnim, tyAnim]
  );

  useEffect(() => {
    animateTo(1, 0, 0, false);
  }, [uri, animateTo]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (evt) => {
          hasMovedRef.current = false;
          panDxOffsetRef.current = 0;
          panDyOffsetRef.current = 0;

          const touches = evt.nativeEvent.touches;
          if (touches.length >= 2) {
            const [t1, t2] = touches;
            const dx = t2.pageX - t1.pageX;
            const dy = t2.pageY - t1.pageY;
            pinchStartDistRef.current = Math.max(1, Math.hypot(dx, dy));
            pinchStartScaleRef.current = scaleRef.current;
            pinchStartCenterRef.current = {
              x: (t1.pageX + t2.pageX) / 2,
              y: (t1.pageY + t2.pageY) / 2,
            };
            pinchStartTxRef.current = txRef.current;
            pinchStartTyRef.current = tyRef.current;
            gestureModeRef.current = 'pinch';
          } else {
            panStartTxRef.current = txRef.current;
            panStartTyRef.current = tyRef.current;
            gestureModeRef.current = 'pan';
          }
        },
        onPanResponderMove: (evt, gestureState) => {
          const touches = evt.nativeEvent.touches;
          if (touches.length >= 2) {
            hasMovedRef.current = true;
            const [t1, t2] = touches;
            const dx = t2.pageX - t1.pageX;
            const dy = t2.pageY - t1.pageY;
            const dist = Math.max(1, Math.hypot(dx, dy));
            const centerX = (t1.pageX + t2.pageX) / 2;
            const centerY = (t1.pageY + t2.pageY) / 2;

            if (gestureModeRef.current !== 'pinch') {
              pinchStartDistRef.current = dist;
              pinchStartScaleRef.current = scaleRef.current;
              pinchStartCenterRef.current = { x: centerX, y: centerY };
              pinchStartTxRef.current = txRef.current;
              pinchStartTyRef.current = tyRef.current;
              gestureModeRef.current = 'pinch';
              return;
            }

            const rawScale = pinchStartScaleRef.current * (dist / pinchStartDistRef.current);
            const nextScale = clampValue(rawScale, 0.85, 4.5);
            const { maxX, maxY } = getBounds(Math.max(1, nextScale));

            const rawTx = pinchStartTxRef.current + (centerX - pinchStartCenterRef.current.x);
            const rawTy = pinchStartTyRef.current + (centerY - pinchStartCenterRef.current.y);
            const clampedTx = clampValue(rawTx, -maxX, maxX);
            const clampedTy = clampValue(rawTy, -maxY, maxY);

            scaleRef.current = nextScale;
            txRef.current = clampedTx;
            tyRef.current = clampedTy;

            scaleAnim.setValue(nextScale);
            txAnim.setValue(clampedTx);
            tyAnim.setValue(clampedTy);
            return;
          }

          if (touches.length === 1) {
            if (Math.abs(gestureState.dx) > 6 || Math.abs(gestureState.dy) > 6) {
              hasMovedRef.current = true;
            }

            if (gestureModeRef.current === 'pinch') {
              // Transition smoothly from 2-finger pinch to 1-finger pan without jumping
              gestureModeRef.current = 'pan';
              panStartTxRef.current = txRef.current;
              panStartTyRef.current = tyRef.current;
              panDxOffsetRef.current = gestureState.dx;
              panDyOffsetRef.current = gestureState.dy;
              return;
            }

            if (scaleRef.current > 1.05) {
              const { maxX, maxY } = getBounds(scaleRef.current);
              const nextTx = clampValue(
                panStartTxRef.current + (gestureState.dx - panDxOffsetRef.current),
                -maxX,
                maxX
              );
              const nextTy = clampValue(
                panStartTyRef.current + (gestureState.dy - panDyOffsetRef.current),
                -maxY,
                maxY
              );

              txRef.current = nextTx;
              tyRef.current = nextTy;
              txAnim.setValue(nextTx);
              tyAnim.setValue(nextTy);
            }
          }
        },
        onPanResponderRelease: (evt, gestureState) => {
          const wasPinch = gestureModeRef.current === 'pinch';
          gestureModeRef.current = 'idle';

          if (wasPinch || scaleRef.current < 1.02) {
            if (scaleRef.current < 1.08) {
              animateTo(1, 0, 0, true);
            } else {
              animateTo(scaleRef.current, txRef.current, tyRef.current, true);
            }
            return;
          }

          if (!hasMovedRef.current) {
            const now = Date.now();
            const touch = evt.nativeEvent.changedTouches?.[0];
            const tapX = touch?.pageX ?? SCREEN_WIDTH / 2;
            const tapY = touch?.pageY ?? SCREEN_HEIGHT / 2;

            const timeDiff = now - lastTapTimeRef.current;
            const tapDist = Math.hypot(
              tapX - lastTapPosRef.current.x,
              tapY - lastTapPosRef.current.y
            );

            if (timeDiff < 280 && tapDist < 48) {
              lastTapTimeRef.current = 0;
              if (scaleRef.current > 1.08) {
                animateTo(1, 0, 0, true);
              } else {
                const targetScale = 2.5;
                const focusTx = (SCREEN_WIDTH / 2 - tapX) * (targetScale - 1);
                const focusTy = (SCREEN_HEIGHT / 2 - tapY) * (targetScale - 1);
                animateTo(targetScale, focusTx, focusTy, true);
              }
            } else {
              lastTapTimeRef.current = now;
              lastTapPosRef.current = { x: tapX, y: tapY };
            }
            return;
          }

          if (scaleRef.current <= 1.05) {
            if (
              Math.abs(gestureState.dx) > 55 &&
              Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.25
            ) {
              if (gestureState.dx > 0) {
                onSwipePrevRef.current?.();
              } else {
                onSwipeNextRef.current?.();
              }
            }
          }
        },
      }),
    [animateTo, scaleAnim, txAnim, tyAnim]
  );

  return (
    <View style={styles.zoomViewport} {...panResponder.panHandlers}>
      <Animated.Image
        source={{ uri }}
        style={{
          width: SCREEN_WIDTH,
          height: SCREEN_HEIGHT * 0.85,
          transform: [
            { translateX: txAnim },
            { translateY: tyAnim },
            { scale: scaleAnim },
          ],
        }}
        resizeMode="contain"
      />
    </View>
  );
};

const GPSCameraOverlay = ({ geoData, sizeRatio = 1, isLive = false }: { geoData: LiveGeoData; sizeRatio?: number; isLive?: boolean }) => {
  const [displayTime, setDisplayTime] = useState(geoData.timestamp);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isLive) interval = setInterval(() => setDisplayTime(formatGeoDate(new Date())), 1000);
    else setDisplayTime(geoData.timestamp);
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isLive, geoData.timestamp]);

  const mapW = 200;
  const mapH = 200;
  const mapUrl = GOOGLE_MAPS_API_KEY
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${geoData.lat},${geoData.lon}&zoom=17&size=${mapW}x${mapH}&scale=2&markers=color:red%7C${geoData.lat},${geoData.lon}&key=${GOOGLE_MAPS_API_KEY}`
    : `https://staticmap.openstreetmap.de/staticmap.php?center=${geoData.lat},${geoData.lon}&zoom=18&size=${mapW}x${mapH}&maptype=mapnik&markers=${geoData.lat},${geoData.lon},red-pushpin&t=${Date.now()}`;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%', paddingHorizontal: 0, paddingBottom: 0 }} collapsable={false}>
      <View
        style={{
          width: 90 * sizeRatio,
          height: 90 * sizeRatio,
          borderRadius: 8 * sizeRatio,
          overflow: 'hidden',
          marginRight: 6 * sizeRatio,
          backgroundColor: '#E2E8F0',
          borderWidth: 1 * sizeRatio,
          borderColor: '#FFF',
        }}
        collapsable={false}
      >
        {geoData.lat === '0.000000' ? (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Ionicons name="map" size={24 * sizeRatio} color="#94A3B8" />
          </View>
        ) : (
          <Image source={{ uri: mapUrl }} style={{ flex: 1, width: '100%', height: '100%', resizeMode: 'cover' }} />
        )}
      </View>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.55)',
          borderRadius: 8 * sizeRatio,
          paddingHorizontal: 8 * sizeRatio,
          paddingVertical: 5 * sizeRatio,
          justifyContent: 'center',
          minHeight: 90 * sizeRatio,
        }}
        collapsable={false}
      >
        <Text allowFontScaling={false} style={{ color: '#FFF', fontSize: 14 * sizeRatio, fontWeight: 'bold' }} numberOfLines={1}>
          {geoData.shortLocation}
        </Text>
        <Text allowFontScaling={false} style={{ color: '#E2E8F0', fontSize: 11 * sizeRatio, lineHeight: 13 * sizeRatio, marginVertical: 2 * sizeRatio }} numberOfLines={3}>
          {toTitleCase(geoData.address)}
        </Text>
        <Text allowFontScaling={false} style={{ color: '#F8FAFC', fontSize: 11 * sizeRatio, fontWeight: 'bold' }} numberOfLines={1}>
          Lat {geoData.lat}°   Long {geoData.lon}°
        </Text>
        <Text allowFontScaling={false} style={{ color: '#F8FAFC', fontSize: 10 * sizeRatio }} numberOfLines={1}>
          {displayTime}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  appBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 15, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  backBtn: { padding: 5, marginLeft: -5 },
  appBarTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  appBarShareBtn: { padding: 6, borderRadius: 10, backgroundColor: '#EFF6FF' },
  listContent: { paddingTop: 15, paddingBottom: 150 },
  detailsCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 18, marginHorizontal: 15, marginBottom: 18, borderWidth: 1, borderColor: '#E2E8F0', elevation: 2 },
  detailsHeaderNoAvatar: { alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  beneficiaryCode: { fontSize: 14, color: '#2563EB', fontWeight: '800', textAlign: 'center', marginBottom: 4 },
  beneficiaryName: { fontSize: 21, fontWeight: '900', color: '#1E293B', textAlign: 'center' },
  divider: { height: 1, backgroundColor: '#F1F5F9', marginVertical: 12 },

  detailRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 9 },
  detailLabel: { width: 112, fontSize: 14, color: '#1E293B', fontWeight: '800', lineHeight: 20 },
  detailColon: { width: 14, fontSize: 14, color: '#1E293B', fontWeight: '800', lineHeight: 20 },
  detailValue: { flex: 1, flexShrink: 1, fontSize: 14, color: '#334155', fontWeight: '600', lineHeight: 20 },

  detailsGrid: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 4 },
  detailItem: { alignItems: 'center' },
  gridLabel: { fontSize: 11, color: '#94A3B8', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 4 },
  gridValue: { fontSize: 14, color: '#334155', fontWeight: 'bold' },

  reportCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 14,
    marginHorizontal: 15,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    elevation: 1,
  },
  reportTopBadgeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  reportBadgeTitle: { fontSize: 13, fontWeight: '800', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 },
  reportOwnerPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1 },
  pillYou: { backgroundColor: '#DCFCE7', borderColor: '#86EFAC' },
  pillImported: { backgroundColor: '#FEF3C7', borderColor: '#FDE047' },
  reportOwnerPillText: { fontSize: 11, fontWeight: '800' },
  pillTextYou: { color: '#166534' },
  pillTextImported: { color: '#92400E' },

  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  imageWrapper: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
    marginBottom: IMAGE_GAP,
    backgroundColor: '#E2E8F0',
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  thumbnail: { width: '100%', height: '100%', resizeMode: 'cover' },
  photoShareBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    padding: 6,
    borderRadius: 14,
  },
  geoBadge: { position: 'absolute', bottom: 6, right: 6, backgroundColor: 'rgba(0,0,0,0.6)', padding: 4, borderRadius: 10 },
  emptyReportPhotos: { alignItems: 'center', paddingVertical: 20, backgroundColor: '#F8FAFC', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  emptyReportPhotosText: { color: '#94A3B8', fontSize: 13, marginTop: 6, fontWeight: '600' },

  sectionDivider: { height: 1, backgroundColor: '#F1F5F9', marginVertical: 14 },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: '#1E293B' },
  editNoteIcon: { padding: 6, backgroundColor: '#EFF6FF', borderRadius: 8 },
  immutableEditNotice: {
    fontSize: 12,
    color: '#92400E',
    backgroundColor: '#FEFCE8',
    borderWidth: 1,
    borderColor: '#FDE047',
    padding: 8,
    borderRadius: 8,
    marginBottom: 8,
    lineHeight: 17,
  },
  notesInputActive: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#2563EB', borderRadius: 12, padding: 14, fontSize: 15, color: '#1E293B', minHeight: 96 },
  notesInput: { backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 14, minHeight: 74, justifyContent: 'center' },
  noteEditBtnRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  cancelNoteBtn: { flex: 1, backgroundColor: '#F1F5F9', padding: 12, borderRadius: 10, alignItems: 'center' },
  cancelNoteText: { color: '#64748B', fontWeight: 'bold' },
  saveNoteBtn: { flex: 2, backgroundColor: '#10B981', padding: 12, borderRadius: 10, alignItems: 'center' },
  saveNoteText: { color: '#FFF', fontWeight: 'bold' },

  authorInfoBlock: { backgroundColor: '#F8FAFC', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  authorInfoRow: { flexDirection: 'row', alignItems: 'center' },
  authorIconBadge: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 11,
  },
  authorInfoTextCol: { flex: 1 },
  authorInfoLabel: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  authorInfoValue: { fontSize: 14.5, color: '#1E293B', fontWeight: '700' },
  authorInfoDivider: { height: 1, backgroundColor: '#E2E8F0', marginVertical: 9 },

  emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24, paddingHorizontal: 20 },
  emptyText: { color: '#475569', marginTop: 10, fontSize: 14, fontWeight: 'bold' },
  fabContainer: { position: 'absolute', bottom: 30, right: 20, alignItems: 'center' },
  fab: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#2563EB', justifyContent: 'center', alignItems: 'center', elevation: 6 },
  cameraContainer: { flex: 1, backgroundColor: '#000' },
  cameraTopBtn: { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, alignItems: 'center', justifyContent: 'center', minWidth: 60, marginBottom: 4 },
  cameraTopBtnText: { color: '#FFF', fontSize: 12, fontWeight: 'bold', marginTop: 4, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  zoomControls: { position: 'absolute', top: 75, flexDirection: 'row', alignItems: 'center', gap: 15 },
  zoomBtnIndividual: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  zoomBtnText: { color: '#FFF', fontSize: 24, fontWeight: 'bold' },
  cameraControlsContainer: { position: 'absolute', bottom: 40, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 30, zIndex: 50 },
  cameraSideBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  cameraCaptureBtnOuter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  cameraCaptureBtnInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#FFF' },
  gpsWaitingOverlay: { position: 'absolute', top: 20, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, flexDirection: 'row', alignItems: 'center', zIndex: 10 },
  viewerContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  zoomViewport: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  viewerHeader: { position: 'absolute', top: 40, right: 20, zIndex: 10, flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 10, borderRadius: 20 },
  viewerActionBtn: { padding: 5, marginHorizontal: 5 },
  swipeLeftBtn: { position: 'absolute', left: 20, zIndex: 50, padding: 10, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 30 },
  swipeRightBtn: { position: 'absolute', right: 20, zIndex: 50, padding: 10, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 30 },
});