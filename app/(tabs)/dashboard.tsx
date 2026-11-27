import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SectionList, ActivityIndicator, Alert, Modal, TextInput, ScrollView, TouchableWithoutFeedback, BackHandler, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as IntentLauncher from 'expo-intent-launcher';
import { generateZipArchive, shareProjectsZipArchive } from '../../utils/fileHelpers';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/appStore';
import { isOwnedByCurrentUser } from '../../utils/authorHelpers';
import { deleteProjectFromDevice } from '../../utils/database';

export interface BeneficiaryItem {
  code: string;
  original_code?: string | null;
  name: string;
  district_name: string;
  city_name: string;
  author_id?: string | null;
  author_name?: string | null;
  photo_count: number;
  sync_status: string;
  inspection_status: string;
  last_updated: string;
  is_legacy?: boolean;
  exact_path?: string;
}

const SORT_OPTIONS = ['Name A-Z', 'Name Z-A', 'Recently Inspected'] as const;
type SortMode = typeof SORT_OPTIONS[number];

const getShortSortName = (sort: SortMode) => {
  if (sort === 'Recently Inspected') return 'Recent';
  if (sort === 'Name A-Z') return 'A-Z';
  if (sort === 'Name Z-A') return 'Z-A';
  return sort;
};

const toTitleCase = (str?: string | null) => {
  if (!str) return 'N/A';
  const cleanStr = str.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
  return cleanStr.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
};

const getFirstWord = (str?: string | null) => {
  if (!str || str === 'N/A' || str === 'All Cities' || str === 'All Districts') return str;
  return str.split(/[\s,]+/)[0].replace(/[^a-zA-Z0-9]/g, '');
};

const parseSafeDate = (raw?: string | null): Date => {
  if (!raw) return new Date(0);
  const normalized = raw.includes('T') || raw.includes('Z') ? raw : raw.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (!isNaN(d.getTime())) return d;
  const fallback = new Date(raw);
  return isNaN(fallback.getTime()) ? new Date(0) : fallback;
};

export default function DashboardScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId, authorId, userName, officialName, seedSyncVersion } = useAppStore();

  const ownershipCtx = {
    currentAuthorId: authorId,
    currentUserId: userId,
    currentOfficialName: officialName,
    currentUserName: userName,
  };

  const [dashDistrict, setDashDistrict] = useState<string | null>(null);
  const [dashCity, setDashCity] = useState<string | null>(null);
  
  const [rawGroupedData, setRawGroupedData] = useState<{title: string, dateObj: Date, data: BeneficiaryItem[]}[]>([]);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const hasAutoExpanded = useRef(false);

  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasLoadedOnceRef = useRef(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  
  const [sortMode, setSortMode] = useState<SortMode>('Recently Inspected');
  const [searchQuery, setSearchQuery] = useState('');
  
  const [uniqueDistricts, setUniqueDistricts] = useState<string[]>([]);
  const [uniqueCities, setUniqueCities] = useState<string[]>([]);
  const [uniqueAuthors, setUniqueAuthors] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[] | null>(null);
  const [activeDropdown, setActiveDropdown] = useState<'district' | 'city' | 'sort' | 'author' | null>(null);

  const [showPdfSettings, setShowPdfSettings] = useState(false);
  const [pdfRows, setPdfRows] = useState('2');
  const [pdfCols, setPdfCols] = useState('2');
  const [isLandscape, setIsLandscape] = useState(false);
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const cancelRef = useRef({ current: false });

  const [showCityPrompt, setShowCityPrompt] = useState(false);
  const [fallbackCity, setFallbackCity] = useState('');

  const [tapCount, setTapCount] = useState(0);
  const [isAdvancedMode, setIsAdvancedMode] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [advancedPin, setAdvancedPin] = useState('');

  const loadFilterOptions = useCallback(async () => {
    try {
      const dists = await db.getAllAsync<{district_name: string}>(`SELECT DISTINCT district_name FROM beneficiaries WHERE district_name IS NOT NULL AND district_name != '' ORDER BY district_name ASC`);
      setUniqueDistricts(dists.map(d => d.district_name));

      let cityQuery = `SELECT DISTINCT city_name FROM beneficiaries WHERE city_name IS NOT NULL AND city_name != ''`;
      const cityParams: string[] = [];
      if (dashDistrict) { cityQuery += ` AND LOWER(TRIM(district_name)) = LOWER(TRIM(?))`; cityParams.push(dashDistrict); }
      cityQuery += ` ORDER BY city_name ASC`;
      const cits = await db.getAllAsync<{city_name: string}>(cityQuery, cityParams);
      setUniqueCities(cits.map(c => c.city_name));

      const authorRows = await db.getAllAsync<{ author_label: string }>(
        `SELECT DISTINCT COALESCE(NULLIF(TRIM(b.author_name), ''), NULLIF(TRIM(p.author_name), ''), 'Unassigned') as author_label
         FROM beneficiaries b
         INNER JOIN photos p ON b.code = p.beneficiary_code
         ORDER BY author_label ASC`
      );
      const authorsList = authorRows.map((a) => a.author_label);
      const sortedAuthors = [
        ...authorsList.filter((a) => a !== 'Unassigned'),
        ...(authorsList.includes('Unassigned') ? ['Unassigned'] : []),
      ];
      setUniqueAuthors(sortedAuthors);
    } catch {}
  }, [db, dashDistrict]);

  const loadGroupedBeneficiaries = useCallback(async () => {
    if (!hasLoadedOnceRef.current) {
      setIsLoading(true);
    }
    try {
      let query = `
        SELECT b.code, b.original_code, b.name, b.district_name, b.city_name,
               COALESCE(
                 NULLIF(TRIM((SELECT r.author_id FROM reports r WHERE r.beneficiary_code = b.code ORDER BY r.created_at DESC LIMIT 1)), ''),
                 NULLIF(TRIM(b.author_id), ''),
                 NULLIF(TRIM(MAX(p.author_id)), ''),
                 ''
               ) as author_id,
               COALESCE(
                 NULLIF(TRIM((SELECT r.author_name FROM reports r WHERE r.beneficiary_code = b.code ORDER BY r.created_at DESC LIMIT 1)), ''),
                 NULLIF(TRIM(b.author_name), ''),
                 NULLIF(TRIM(MAX(p.author_name)), ''),
                 'Unassigned'
               ) as author_name,
               b.sync_status, b.inspection_status, MAX(p.created_at) as last_updated, COUNT(p.id) as photo_count
        FROM beneficiaries b
        INNER JOIN photos p ON b.code = p.beneficiary_code
        WHERE 1=1
      `;
      const params: (string | number)[] = [];

      if (searchQuery) {
        query += ` AND (b.name LIKE ? OR b.code LIKE ? OR b.original_code LIKE ?)`;
        params.push(`%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`);
      }
      if (dashDistrict) {
        query += ` AND LOWER(TRIM(b.district_name)) = LOWER(TRIM(?))`;
        params.push(dashDistrict);
      }
      if (dashCity) {
        query += ` AND LOWER(TRIM(b.city_name)) = LOWER(TRIM(?))`;
        params.push(dashCity);
      }

      query += ` GROUP BY b.code`;

      if (sortMode === 'Name A-Z') query += ` ORDER BY b.name ASC`;
      else if (sortMode === 'Name Z-A') query += ` ORDER BY b.name DESC`;
      else query += ` ORDER BY last_updated DESC`;

      const results = await db.getAllAsync<BeneficiaryItem>(query, params);
      let combinedResults = [...results];

      if (isAdvancedMode) {
        const rootDir = Paths.document;
        if (rootDir.exists) {
          const existingCodes = new Set(results.map(r => r.code));
          const excludeList = ['SQLite', 'RCTAsyncLocalStorage', 'fonts', 'assets', 'projects_cache', '.expo', 'HousingInspection'];

          const scanLegacyFolder = (dir: Directory): { count: number; latest: number } => {
            let count = 0;
            let latest = 0;
            try {
              for (const entry of dir.list()) {
                if (entry instanceof Directory) {
                  const sub = scanLegacyFolder(entry);
                  count += sub.count;
                  if (sub.latest > latest) latest = sub.latest;
                } else if (entry.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) {
                  count++;
                  const modTime = entry.modificationTime;
                  if (modTime && modTime > latest) latest = modTime;
                }
              }
            } catch {}
            return { count, latest };
          };

          let items: (Directory | File)[] = [];
          try {
            items = rootDir.list();
          } catch {
            items = [];
          }
          for (const item of items) {
            if (!(item instanceof Directory)) continue;
            const itemName = item.name;
            if (itemName.startsWith('.') || excludeList.includes(itemName) || existingCodes.has(itemName)) continue;

            const { count, latest } = scanLegacyFolder(item);
            if (count > 0) {
              combinedResults.push({
                code: itemName,
                name: `Manual: ${itemName}`,
                district_name: 'Legacy Entry',
                city_name: '',
                photo_count: count,
                sync_status: 'offline',
                inspection_status: 'legacy',
                last_updated: latest > 0 ? new Date(latest).toISOString() : new Date().toISOString(),
                is_legacy: true,
                exact_path: item.uri
              });
            }
          }
        }
      }

      if (sortMode === 'Recently Inspected') {
        combinedResults.sort((a, b) => parseSafeDate(b.last_updated).getTime() - parseSafeDate(a.last_updated).getTime());
      } else if (sortMode === 'Name A-Z') {
        combinedResults.sort((a, b) => a.name.localeCompare(b.name));
      } else {
        combinedResults.sort((a, b) => b.name.localeCompare(a.name));
      }

      if (selectedAuthors !== null) {
        const allowed = new Set(selectedAuthors);
        combinedResults = combinedResults.filter((item) =>
          allowed.has(item.author_name?.trim() || 'Unassigned')
        );
      }

      interface DateGroup {
        title: string;
        dateObj: Date;
        data: BeneficiaryItem[];
      }

      const groups = combinedResults.reduce<Record<string, DateGroup>>((acc, current) => {
        const dateObj = parseSafeDate(current.last_updated);
        const dateStr = dateObj.getTime() > 0
          ? dateObj.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) 
          : 'Unknown Date';

        if (!acc[dateStr]) acc[dateStr] = { title: dateStr, dateObj, data: [] };
        acc[dateStr].data.push(current);
        return acc;
      }, {});

      const formattedSections = Object.values(groups).sort(
        (a, b) => b.dateObj.getTime() - a.dateObj.getTime()
      );
      
      setRawGroupedData(formattedSections);
      hasLoadedOnceRef.current = true;

      // Expand the most recent section automatically on initial load
      if (!hasAutoExpanded.current && formattedSections.length > 0) {
        setExpandedDates(new Set([formattedSections[0].title]));
        hasAutoExpanded.current = true;
      }

    } catch (error) {
      console.error("Failed to load dashboard data", error);
    } finally {
      setIsLoading(false);
    }
  }, [db, searchQuery, dashDistrict, dashCity, sortMode, isAdvancedMode, selectedAuthors]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isSelectionMode) {
        setSelectedCodes([]);
        setIsSelectionMode(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [isSelectionMode]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await loadFilterOptions();
      await loadGroupedBeneficiaries();
    } finally {
      setIsRefreshing(false);
    }
  }, [loadFilterOptions, loadGroupedBeneficiaries]);

  useFocusEffect(
    useCallback(() => {
      loadFilterOptions();
      loadGroupedBeneficiaries();
    }, [loadFilterOptions, loadGroupedBeneficiaries, seedSyncVersion])
  );

  const handleTitleTap = () => {
    setTapCount(prev => {
      if (prev + 1 >= 5) {
        if (isAdvancedMode) {
          setIsAdvancedMode(false);
          Alert.alert("Normal Mode", "Returned to standard database view.");
          return 0;
        } else {
          setShowPinModal(true);
          return 0;
        }
      }
      return prev + 1;
    });
  };

  const handlePinSubmit = () => {
    if (advancedPin === '1234') { 
      setIsAdvancedMode(true);
      setShowPinModal(false);
      setAdvancedPin('');
      Alert.alert("Advanced Mode Active", "Deep legacy filesystem scan activated for manual project folders.");
    } else {
      Alert.alert("Denied", "Incorrect PIN.");
      setShowPinModal(false);
      setAdvancedPin('');
    }
  };

  const toggleSectionExpansion = (dateStr: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev);
      if (next.has(dateStr)) next.delete(dateStr);
      else next.add(dateStr);
      return next;
    });
  };

  const exitSelectionMode = () => {
    setSelectedCodes([]);
    setIsSelectionMode(false);
  };

  const enterSelectionMode = (code: string) => {
    setIsSelectionMode(true);
    setSelectedCodes(prev => (prev.includes(code) ? prev : [...prev, code]));
  };

  const toggleSelection = (code: string) => {
    setSelectedCodes(prev => {
      const next = prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code];
      if (next.length === 0) {
        setIsSelectionMode(false);
      }
      return next;
    });
  };

  const toggleSection = (sectionData: BeneficiaryItem[]) => {
    if (sectionData.length === 0) return;
    const sectionCodes = sectionData.map(item => item.code);
    const allSelected = sectionCodes.every(code => selectedCodes.includes(code));
    if (allSelected) {
      const next = selectedCodes.filter(c => !sectionCodes.includes(c));
      setSelectedCodes(next);
      if (next.length === 0) setIsSelectionMode(false);
    } else {
      setIsSelectionMode(true);
      setSelectedCodes(prev => Array.from(new Set([...prev, ...sectionCodes])));
    }
  };

  const handleSelectAll = () => {
    const allCodes = rawGroupedData.flatMap(g => g.data.map(item => item.code));
    if (allCodes.length === 0) return;
    setIsSelectionMode(true);
    setSelectedCodes(Array.from(new Set(allCodes)));
  };

  const getSelectedItems = () => {
    return rawGroupedData.flatMap(g => g.data).filter(item => selectedCodes.includes(item.code));
  };

  const handleShareSelected = async () => {
    const selectedItems = getSelectedItems();
    if (selectedItems.length === 0) return;

    setIsProcessing(true);
    setProgressPercent(0);
    setProgressMsg('Preparing share package...');
    cancelRef.current.current = false;

    try {
      const zipUri = await shareProjectsZipArchive(
        db,
        selectedItems,
        (msg, pct) => {
          setProgressMsg(msg);
          setProgressPercent(pct);
        },
        cancelRef.current
      );
      setIsProcessing(false);
      if (zipUri) {
        await Sharing.shareAsync(zipUri, {
          mimeType: 'application/zip',
          dialogTitle: 'Share Selected Projects',
        });
        exitSelectionMode();
      } else if (!cancelRef.current.current) {
        Alert.alert(
          'Nothing to Share',
          'The selected project(s) have no photos, notes, or reports to share.'
        );
      }
    } catch (e: unknown) {
      setIsProcessing(false);
      const msg = e instanceof Error ? e.message : 'Failed to prepare share package.';
      if (msg !== 'Cancelled by user') Alert.alert('Share Error', msg);
    }
  };

  const handleDeleteSelected = () => {
    const selectedItems = getSelectedItems();
    if (selectedItems.length === 0) return;

    Alert.alert(
      'Delete Selected Projects',
      `Are you sure you want to permanently delete ${selectedItems.length} selected project(s), including all their photos and notes? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setIsProcessing(true);
            setProgressMsg('Deleting selected projects...');
            setProgressPercent(20);
            try {
              for (let i = 0; i < selectedItems.length; i++) {
                const item = selectedItems[i];
                setProgressPercent(20 + Math.round(((i + 1) / selectedItems.length) * 80));
                if (item.is_legacy && item.exact_path) {
                  const dir = new Directory(item.exact_path);
                  if (dir.exists) dir.delete();
                } else {
                  await deleteProjectFromDevice(db, item.code);
                }
              }
              setIsProcessing(false);
              exitSelectionMode();
              await loadFilterOptions();
              await loadGroupedBeneficiaries();
            } catch {
              setIsProcessing(false);
              Alert.alert('Delete Failed', 'Could not delete one or more selected projects.');
            }
          },
        },
      ]
    );
  };

  const handleZipTrigger = async () => {
    const selectedItems = getSelectedItems();
    if (selectedItems.length === 0) return;
    
    // Check if any standard database item is missing a city
    const needsCity = selectedItems.some(r => !r.is_legacy && (!r.city_name || r.city_name.trim() === ''));
    
    if (needsCity) {
      setFallbackCity(''); 
      setShowCityPrompt(true);
    } else {
      startZipExport('');
    }
  };

  const startZipExport = async (fallbackCityStr: string) => {
    setShowCityPrompt(false);
    setIsProcessing(true);
    setProgressPercent(0);
    cancelRef.current.current = false;

    try {
      const selectedItems = getSelectedItems();
      const zipUri = await generateZipArchive(db, selectedItems, fallbackCityStr, (msg, pct) => {
        setProgressMsg(msg);
        setProgressPercent(pct);
      }, cancelRef.current);

      setIsProcessing(false);
      
      if (zipUri) {
        try {
          const pickedDir = await Directory.pickDirectoryAsync();
          const zipFile = new File(zipUri);
          const destFile = pickedDir.createFile(zipFile.name || 'Export.zip', 'application/zip');
          const zipBytes = await zipFile.bytes();
          destFile.write(zipBytes);
          Alert.alert("Saved", "ZIP saved to your selected folder.");
          exitSelectionMode();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : '';
          if (msg.toLowerCase().includes('cancel')) return;
          Alert.alert("Save Error", "Direct saving was blocked by the OS due to memory size limits. Please use the Share button instead.");
        }
      }
    } catch (e: unknown) {
      setIsProcessing(false);
      const msg = e instanceof Error ? e.message : 'Export failed.';
      if (msg !== "Cancelled by user") Alert.alert("Error", msg);
    }
  };

  const handleGeneratePdf = async () => {
    setShowPdfSettings(false);
    setIsProcessing(true);
    setProgressPercent(0);
    cancelRef.current.current = false;
    setProgressMsg("Gathering layout parameters...");

    try {
      const selectedItems = getSelectedItems();
      const groupedByCity: Record<string, BeneficiaryItem[]> = {};
      
      for (const item of selectedItems) {
        const city = item.is_legacy ? 'Manual_Projects' : (item.city_name || 'Unknown_City');
        if (!groupedByCity[city]) groupedByCity[city] = [];
        groupedByCity[city].push(item);
      }

      const pdfFilenameParts: string[] = [];
      const allCitiesData: { city: string; photos: { caption: string; base64?: string }[] }[] = [];
      const totalExpectedPhotos = Math.max(1, selectedItems.reduce((acc, curr) => acc + curr.photo_count, 0));
      let totalPhotosGlobal = 0;

      for (const city of Object.keys(groupedByCity)) {
        const cityBeneficiaries = groupedByCity[city];
        const cityPhotos: { caption: string; base64?: string }[] = [];
        let citySerialNo = 1;
        
        for (let i = 0; i < cityBeneficiaries.length; i++) {
          const b = cityBeneficiaries[i];
          let photoUris: string[] = [];

          if (b.is_legacy && b.exact_path) {
              const findPhotosRecursively = (dir: Directory): string[] => {
                  const found: string[] = [];
                  for (const entry of dir.list()) {
                      if (entry instanceof Directory) found.push(...findPhotosRecursively(entry));
                      else if (entry.name.toLowerCase().match(/\.(jpg|jpeg|png)$/)) found.push(entry.uri);
                  }
                  return found;
              };
              photoUris = findPhotosRecursively(new Directory(b.exact_path));
          } else {
              const photos = await db.getAllAsync<{ local_uri: string }>(`SELECT local_uri FROM photos WHERE beneficiary_code = ? ORDER BY created_at ASC`, [b.code]);
              photoUris = photos.map(p => p.local_uri);
          }

          for (let j = 0; j < photoUris.length; j++) {
            if (cancelRef.current.current) throw new Error("Cancelled by user");
            const uri = photoUris[j].split('?')[0];
            if (!new File(uri).exists) continue;
            
            totalPhotosGlobal++;
            setProgressPercent(Math.round((totalPhotosGlobal / totalExpectedPhotos) * 100));
            setProgressMsg(`Formatting image ${totalPhotosGlobal} of ${totalExpectedPhotos}...`);
            
            const manipResult = await ImageManipulator.manipulateAsync(
              uri, [{ resize: { width: 800 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
            );

            const suffix = photoUris.length > 1 ? `_${j + 1}` : ``;
            const caption = `${citySerialNo}. ${b.name || ""}<br/>${b.code || ""}${suffix}`.trim();
            cityPhotos.push({ caption, base64: manipResult.base64 });
          }
          citySerialNo++;
        }
        
        if (cityPhotos.length > 0) {
          const safeName = city.replace(/[^a-zA-Z0-9]/g, '');
          pdfFilenameParts.push(`${safeName}-${cityPhotos.length}`);
          allCitiesData.push({ city, photos: cityPhotos });
        }
      }

      if (allCitiesData.length === 0) throw new Error("No photos found.");

      setProgressMsg("Formatting A4 PDF Document...");
      const rows = parseInt(pdfRows) || 2;
      const cols = parseInt(pdfCols) || 2;
      const itemsPerPage = rows * cols;
      let pagesHtml = '';

      allCitiesData.forEach((cityGroup, index) => {
        if (index > 0) pagesHtml += `<div style="page-break-before: always;"></div>`;
        for (let i = 0; i < cityGroup.photos.length; i += itemsPerPage) {
          if (cancelRef.current.current) throw new Error("Cancelled by user");
          const chunk = cityGroup.photos.slice(i, i + itemsPerPage);
          pagesHtml += `<div class="page">`;
          chunk.forEach(photo => {
            pagesHtml += `
              <div class="img-cell">
                <img src="data:image/jpeg;base64,${photo.base64}" />
                <div class="caption">${photo.caption}</div>
              </div>
            `;
          });
          pagesHtml += `</div>`;
        }
      });

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            @page { size: ${isLandscape ? 'A4 landscape' : 'A4 portrait'}; margin: 0; }
            body { margin: 0; padding: 0; box-sizing: border-box; background: white; font-family: sans-serif; }
            .page { 
              width: ${isLandscape ? '297mm' : '210mm'}; 
              height: ${isLandscape ? '210mm' : '297mm'}; 
              page-break-after: always; padding: 10mm; box-sizing: border-box; display: grid;
              grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${rows}, 1fr); gap: 10mm;
            }
            .img-cell { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; overflow: hidden; }
            .img-cell img { max-width: 100%; max-height: 85%; object-fit: contain; border: 1px solid #CBD5E1; border-radius: 4px; }
            .caption { margin-top: 8px; font-size: 13px; color: #1E293B; text-align: center; word-wrap: break-word; max-width: 100%; line-height: 1.4; font-weight: bold; }
          </style>
        </head>
        <body>${pagesHtml}</body>
        </html>
      `;

      const { uri } = await Print.printToFileAsync({ html });
      const pdfFilename = `${pdfFilenameParts.join('_')}.pdf`;
      const customPdfFile = new File(Paths.cache, pdfFilename);
      if (customPdfFile.exists) {
        customPdfFile.delete();
      }
      new File(uri).move(customPdfFile);
      const customUri = customPdfFile.uri;

      setIsProcessing(false);
      
      Alert.alert("Success", "PDF created successfully!", [
          { text: "View", onPress: async () => {
             try {
                const cUri = customPdfFile.contentUri;
                await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: cUri, flags: 1, type: 'application/pdf' });
             } catch { Alert.alert("Error", "No PDF Viewer installed on this device."); }
          }},
          { text: "Share", onPress: () => Sharing.shareAsync(customUri) },
          { text: "Cancel", style: "cancel" }
      ]);
      exitSelectionMode();

    } catch (error: unknown) {
      setIsProcessing(false);
      const msg = error instanceof Error ? error.message : 'Could not generate PDF document.';
      if (msg !== "Cancelled by user") Alert.alert("Failed", msg);
    }
  };

  const toggleAuthorOption = (author: string) => {
    const current = selectedAuthors === null ? [...uniqueAuthors] : [...selectedAuthors];
    const idx = current.indexOf(author);
    if (idx !== -1) {
      current.splice(idx, 1);
    } else {
      current.push(author);
    }
    if (uniqueAuthors.length > 0 && current.length === uniqueAuthors.length) {
      setSelectedAuthors(null);
    } else {
      setSelectedAuthors(current);
    }
  };

  const toggleSelectAllAuthors = () => {
    const allSelected = selectedAuthors === null || selectedAuthors.length === uniqueAuthors.length;
    setSelectedAuthors(allSelected ? [] : null);
  };

  const getAuthorButtonLabel = (): string => {
    if (selectedAuthors === null) return 'Author';
    if (selectedAuthors.length === 0) return 'No Author';
    if (selectedAuthors.length === 1) return getFirstWord(selectedAuthors[0]) || 'Author';
    return `Author (${selectedAuthors.length})`;
  };

  const renderDropdownModal = () => {
    const allAuthorsChecked =
      selectedAuthors === null ||
      (uniqueAuthors.length > 0 && selectedAuthors.length === uniqueAuthors.length);

    return (
      <Modal visible={activeDropdown !== null} transparent animationType="fade" onRequestClose={() => setActiveDropdown(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setActiveDropdown(null)}>
          <TouchableWithoutFeedback>
            <View style={styles.dropdownCard}>
              <Text style={styles.dropdownTitle}>
                {activeDropdown === 'district'
                  ? 'Select District'
                  : activeDropdown === 'city'
                  ? 'Select City'
                  : activeDropdown === 'author'
                  ? 'Filter by Author'
                  : 'Sort By'}
              </Text>
              <ScrollView style={{ maxHeight: 320 }}>
                {activeDropdown === 'sort' && SORT_OPTIONS.map((opt) => (
                  <TouchableOpacity key={opt} style={styles.dropdownOption} onPress={() => { setSortMode(opt); setActiveDropdown(null); }}>
                    <Text style={[styles.dropdownOptionText, sortMode === opt && styles.dropdownOptionSelectedText]}>{opt}</Text>
                  </TouchableOpacity>
                ))}
                {activeDropdown === 'district' && ['All Districts', ...uniqueDistricts].map((opt) => {
                  const isSelected = dashDistrict === opt || (!dashDistrict && opt === 'All Districts');
                  return (
                    <TouchableOpacity key={opt} style={styles.dropdownOption} onPress={() => { setDashDistrict(opt === 'All Districts' ? null : opt); setActiveDropdown(null); }}>
                      <Text style={[styles.dropdownOptionText, isSelected && styles.dropdownOptionSelectedText]}>{toTitleCase(opt)}</Text>
                    </TouchableOpacity>
                  );
                })}
                {activeDropdown === 'city' && ['All Cities', ...uniqueCities].map((opt) => {
                  const isSelected = dashCity === opt || (!dashCity && opt === 'All Cities');
                  return (
                    <TouchableOpacity key={opt} style={styles.dropdownOption} onPress={() => { setDashCity(opt === 'All Cities' ? null : opt); setActiveDropdown(null); }}>
                      <Text style={[styles.dropdownOptionText, isSelected && styles.dropdownOptionSelectedText]}>{toTitleCase(opt)}</Text>
                    </TouchableOpacity>
                  );
                })}
                {activeDropdown === 'author' && (
                  <>
                    <TouchableOpacity style={styles.authorOptionRow} onPress={toggleSelectAllAuthors}>
                      <View style={[styles.authorCheckbox, allAuthorsChecked && styles.checkboxSelected]}>
                        {allAuthorsChecked && <Ionicons name="checkmark" size={14} color="#FFF" />}
                      </View>
                      <Text style={[styles.authorOptionText, { fontWeight: '800', color: '#0F172A' }]}>
                        Select All Authors
                      </Text>
                    </TouchableOpacity>
                    {uniqueAuthors.map((author) => {
                      const isChecked =
                        selectedAuthors === null || selectedAuthors.includes(author);
                      return (
                        <TouchableOpacity
                          key={author}
                          style={styles.authorOptionRow}
                          onPress={() => toggleAuthorOption(author)}
                        >
                          <View style={[styles.authorCheckbox, isChecked && styles.checkboxSelected]}>
                            {isChecked && <Ionicons name="checkmark" size={14} color="#FFF" />}
                          </View>
                          <Text style={styles.authorOptionText}>{author}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </>
                )}
              </ScrollView>
              <TouchableOpacity
                style={activeDropdown === 'author' ? styles.dropdownDoneBtn : styles.dropdownCancelBtn}
                onPress={() => setActiveDropdown(null)}
              >
                <Text style={activeDropdown === 'author' ? styles.dropdownDoneText : styles.dropdownCancelText}>
                  {activeDropdown === 'author' ? 'Done' : 'Cancel'}
                </Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </TouchableOpacity>
      </Modal>
    );
  };

  const renderedSections = rawGroupedData.map(sec => ({
    title: sec.title,
    dateObj: sec.dateObj,
    originalData: sec.data,
    data: expandedDates.has(sec.title) ? sec.data : []
  }));

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerTop}>
          <TouchableWithoutFeedback onPress={handleTitleTap}>
            <View style={{flexDirection: 'row', alignItems: 'center'}}>
              <Text style={styles.title}>Workspace</Text>
              {isAdvancedMode && <View style={styles.advancedBadge}><Text style={styles.advancedBadgeText}>ADVANCED</Text></View>}
            </View>
          </TouchableWithoutFeedback>
        </View>

        <View style={styles.searchContainer}>
          <Ionicons name="search" size={20} color="#94A3B8" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search Application No. or Name..."
            placeholderTextColor="#94A3B8"
            value={searchQuery}
            onChangeText={setSearchQuery}
            multiline={false}
            numberOfLines={1}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Ionicons name="close-circle" size={20} color="#94A3B8" />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.filterWrapper}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={styles.filterScrollContent}>
            <TouchableOpacity style={[styles.filterBtn, sortMode !== 'Recently Inspected' && styles.filterBtnActive]} onPress={() => setActiveDropdown('sort')}>
              <Ionicons name="swap-vertical" size={14} color={sortMode !== 'Recently Inspected' ? "#2563EB" : "#64748B"} style={{marginRight: 4}} />
              <Text style={[styles.filterBtnText, sortMode !== 'Recently Inspected' && styles.filterBtnTextActive]} numberOfLines={1}>{getShortSortName(sortMode)}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.filterBtn, dashDistrict && styles.filterBtnActive]} onPress={() => setActiveDropdown('district')}>
              <Text style={[styles.filterBtnText, dashDistrict && styles.filterBtnTextActive]} numberOfLines={1}>{getFirstWord(dashDistrict) || 'District'}</Text>
              <Ionicons name="chevron-down" size={14} color={dashDistrict ? "#2563EB" : "#64748B"} />
            </TouchableOpacity>
            
            <TouchableOpacity style={[styles.filterBtn, dashCity && styles.filterBtnActive]} onPress={() => setActiveDropdown('city')}>
              <Text style={[styles.filterBtnText, dashCity && styles.filterBtnTextActive]} numberOfLines={1}>{getFirstWord(dashCity) || 'City'}</Text>
              <Ionicons name="chevron-down" size={14} color={dashCity ? "#2563EB" : "#64748B"} />
            </TouchableOpacity>

            <TouchableOpacity style={[styles.filterBtn, selectedAuthors !== null && styles.filterBtnActive]} onPress={() => setActiveDropdown('author')}>
              <Ionicons name="person-outline" size={13} color={selectedAuthors !== null ? "#2563EB" : "#64748B"} style={{marginRight: 4}} />
              <Text style={[styles.filterBtnText, selectedAuthors !== null && styles.filterBtnTextActive]} numberOfLines={1}>{getAuthorButtonLabel()}</Text>
              <Ionicons name="chevron-down" size={14} color={selectedAuthors !== null ? "#2563EB" : "#64748B"} />
            </TouchableOpacity>
          </ScrollView>

          {(dashDistrict || dashCity || sortMode !== 'Recently Inspected' || selectedAuthors !== null) && (
            <View style={{ paddingLeft: 8 }}>
              <TouchableOpacity onPress={() => { setDashDistrict(null); setDashCity(null); setSortMode('Recently Inspected'); setSelectedAuthors(null); setSearchQuery(''); }} style={styles.fixedClearBtn}>
                <Ionicons name="close-circle" size={26} color="#EF4444" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {isSelectionMode && (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionBarCount}>{selectedCodes.length} Selected</Text>
          <View style={styles.selectionBarActions}>
            <TouchableOpacity style={styles.selectionActionBtn} onPress={handleSelectAll}>
              <Text style={styles.selectionActionText}>Select All</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectionCancelBtn} onPress={exitSelectionMode}>
              <Ionicons name="close" size={16} color="#EF4444" />
              <Text style={styles.selectionCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {isLoading ? (
        <ActivityIndicator size="large" color="#2563EB" style={{ marginTop: 50 }} />
      ) : (
        <SectionList
          sections={renderedSections}
          keyExtractor={(item) => item.code}
          stickySectionHeadersEnabled={true}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 120, paddingTop: 10 }}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={['#2563EB']} tintColor="#2563EB" />
          } 
          renderSectionHeader={({ section: { title, originalData } }) => {
            const isAllSelected = originalData.length > 0 && originalData.every(item => selectedCodes.includes(item.code));
            const isExpanded = expandedDates.has(title);
            
            return (
              <View style={styles.sectionHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  {isSelectionMode && (
                    <TouchableOpacity style={[styles.checkbox, isAllSelected && styles.checkboxSelected, { width: 22, height: 22, marginRight: 10 }]} onPress={() => toggleSection(originalData)}>
                      {isAllSelected && <Ionicons name="checkmark" size={14} color="#FFF" />}
                    </TouchableOpacity>
                  )}
                  <Text style={styles.sectionHeaderText}>{title}</Text>
                </View>
                <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', padding: 5 }} onPress={() => toggleSectionExpansion(title)}>
                  <Text style={styles.sectionCountText}>{originalData.length} Projects</Text>
                  <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color="#64748B" style={{ marginLeft: 6 }} />
                </TouchableOpacity>
              </View>
            );
          }}
          renderItem={({ item }) => {
            const isSelected = selectedCodes.includes(item.code);
            const isMine = !item.is_legacy && isOwnedByCurrentUser(
              { authorId: item.author_id, authorName: item.author_name },
              ownershipCtx
            );
            const isImported = !item.is_legacy && !isMine;

            return (
              <View
                style={[
                  styles.itemCard,
                  isMine && styles.cardWithPhotos,
                  isImported && styles.importedItemCard,
                  item.is_legacy && styles.legacyItemCard,
                  isSelected && styles.itemCardSelected,
                ]}
              >
                {isSelectionMode && (
                  <TouchableOpacity style={[styles.checkbox, isSelected && styles.checkboxSelected]} onPress={() => toggleSelection(item.code)} hitSlop={{top: 15, bottom: 15, left: 10, right: 15}}>
                    {isSelected && <Ionicons name="checkmark" size={16} color="#FFF" />}
                  </TouchableOpacity>
                )}
                
                <TouchableOpacity
                  style={{ flex: 1 }}
                  onPress={() => { 
                    if (isSelectionMode) toggleSelection(item.code); 
                    else if (!item.is_legacy) router.push(`/beneficiary/${encodeURIComponent(item.code)}`); 
                  }} 
                  onLongPress={() => enterSelectionMode(item.code)}
                >
                  <View style={styles.cardHeaderInfo}>
                    {item.is_legacy && <Ionicons name="folder-open" size={18} color="#F59E0B" style={{marginRight: 6}} />}
                    <Text style={styles.itemTitle} numberOfLines={2}>{toTitleCase(item.name)}</Text>
                  </View>
                  <View style={styles.cardSubRow}>
                    <Text style={styles.itemCode}>ID: {item.original_code || item.code}</Text>
                    
                    <View style={{flexDirection: 'row', alignItems: 'center'}}>
                      <View style={[styles.photoCountBadge, (item.is_legacy || isImported) && {backgroundColor: '#FEF3C7'}]}>
                        <Text style={[styles.photoCountText, (item.is_legacy || isImported) && {color: '#B45309'}]}>{item.photo_count}</Text>
                        <Ionicons name="images" size={12} color={(item.is_legacy || isImported) ? "#D97706" : "#10B981"} style={{ marginLeft: 4 }} />
                      </View>
                      {item.sync_status === 'pending' || item.is_legacy ? <Ionicons name="cloud-offline" size={18} color="#D97706" style={{ marginLeft: 8 }} /> : <Ionicons name="cloud-done" size={18} color="#059669" style={{ marginLeft: 8 }} />}
                    </View>
                  </View>
                  <View style={styles.cardFooter}>
                    <Text style={styles.cardDetail}><Ionicons name="location" size={14} color="#64748B" /> {item.is_legacy ? 'Device Directory' : (toTitleCase(item.city_name) || 'N/A')}</Text>
                    {!item.is_legacy && (
                      <View style={[styles.authorBadge, isMine ? styles.authorBadgeYou : styles.authorBadgeImported]}>
                        <Text style={[styles.authorBadgeText, isMine ? styles.authorBadgeTextYou : styles.authorBadgeTextImported]}>
                          {isMine ? 'You' : 'Imported'}
                        </Text>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="folder-open-outline" size={50} color="#CBD5E1" />
              <Text style={styles.emptyStateText}>No active projects found.</Text>
            </View>
          }
        />
      )}

      {selectedCodes.length > 0 && (
        <View style={styles.bottomToolbar}>
          <TouchableOpacity style={[styles.exportBtn, {backgroundColor: '#10B981'}]} onPress={handleZipTrigger}>
            <Ionicons name="save-outline" size={17} color="#FFF" style={{ marginRight: 5 }} />
            <Text style={styles.exportBtnText}>Save</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.exportBtn, {backgroundColor: '#0EA5E9'}]} onPress={handleShareSelected}>
            <Ionicons name="share-social" size={17} color="#FFF" style={{ marginRight: 5 }} />
            <Text style={styles.exportBtnText}>Share</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.exportBtn, {backgroundColor: '#2563EB'}]} onPress={() => setShowPdfSettings(true)}>
            <Ionicons name="document-text" size={17} color="#FFF" style={{ marginRight: 5 }} />
            <Text style={styles.exportBtnText}>PDF</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.exportBtn, {backgroundColor: '#EF4444'}]} onPress={handleDeleteSelected}>
            <Ionicons name="trash" size={17} color="#FFF" style={{ marginRight: 5 }} />
            <Text style={styles.exportBtnText}>Delete</Text>
          </TouchableOpacity>
        </View>
      )}

      {renderDropdownModal()}

      <Modal visible={showCityPrompt} transparent animationType="slide" onRequestClose={() => setShowCityPrompt(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>Missing City Names</Text>
            <Text style={{ fontSize: 14, color: '#64748B', marginBottom: 20, lineHeight: 20 }}>Please provide a fallback city name so we can properly group these legacy/missing projects.</Text>
            <TextInput style={[styles.numInput, { width: '100%', textAlign: 'left', paddingHorizontal: 15, marginBottom: 20 }]} placeholder="e.g., Tharad" value={fallbackCity} onChangeText={setFallbackCity} />
            <View style={styles.settingsActions}>
               <TouchableOpacity style={styles.settingsCancelBtn} onPress={()=>setShowCityPrompt(false)}><Text style={styles.settingsCancelText}>Cancel</Text></TouchableOpacity>
               <TouchableOpacity style={styles.settingsGenerateBtn} onPress={() => startZipExport(fallbackCity)}><Text style={styles.settingsGenerateText}>Continue</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={isProcessing} transparent animationType="fade" onRequestClose={() => { cancelRef.current.current = true; setIsProcessing(false); }}>
        <View style={styles.modalOverlay}>
          <View style={styles.progressCard}>
            <ActivityIndicator size="large" color="#2563EB" style={{ marginBottom: 15 }} />
            <View style={styles.progressBarBg}><View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} /></View>
            <Text style={styles.progressPercentText}>{progressPercent}%</Text>
            <Text style={styles.progressText}>{progressMsg}</Text>
            <TouchableOpacity style={styles.stopBtn} onPress={() => { cancelRef.current.current = true; setIsProcessing(false); }}><Text style={styles.stopBtnText}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showPinModal} transparent animationType="fade" onRequestClose={() => { setShowPinModal(false); setTapCount(0); }}>
        <View style={styles.modalOverlay}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>Admin Access</Text>
            <TextInput style={[styles.numInput, { width: '100%', textAlign: 'left', paddingHorizontal: 15, marginBottom: 20 }]} secureTextEntry placeholder="Enter PIN" value={advancedPin} onChangeText={setAdvancedPin} keyboardType="number-pad" autoFocus />
            <View style={styles.settingsActions}>
               <TouchableOpacity style={styles.settingsCancelBtn} onPress={() => { setShowPinModal(false); setTapCount(0); }}><Text style={styles.settingsCancelText}>Cancel</Text></TouchableOpacity>
               <TouchableOpacity style={[styles.settingsGenerateBtn, {backgroundColor: '#EF4444'}]} onPress={handlePinSubmit}><Text style={styles.settingsGenerateText}>Unlock</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showPdfSettings} transparent animationType="slide" onRequestClose={() => setShowPdfSettings(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>PDF Export Settings</Text>
            <View style={styles.settingRow}>
               <Text style={styles.settingLabel}>Images Per Page</Text>
               <View style={{flexDirection: 'row', alignItems: 'center', gap: 10}}>
                  <TextInput style={styles.numInput} value={pdfRows} onChangeText={setPdfRows} keyboardType="numeric" maxLength={1} selectTextOnFocus />
                  <Text style={{fontWeight: 'bold', color: '#64748B'}}>Rows x</Text>
                  <TextInput style={styles.numInput} value={pdfCols} onChangeText={setPdfCols} keyboardType="numeric" maxLength={1} selectTextOnFocus />
                  <Text style={{fontWeight: 'bold', color: '#64748B'}}>Cols</Text>
               </View>
            </View>
            <View style={styles.settingRow}>
               <Text style={styles.settingLabel}>Orientation</Text>
               <View style={{flexDirection: 'row', gap: 10}}>
                 <TouchableOpacity style={[styles.orientBtn, !isLandscape && styles.orientBtnActive]} onPress={()=>setIsLandscape(false)}><Text style={[styles.orientText, !isLandscape && styles.orientTextActive]}>Portrait</Text></TouchableOpacity>
                 <TouchableOpacity style={[styles.orientBtn, isLandscape && styles.orientBtnActive]} onPress={()=>setIsLandscape(true)}><Text style={[styles.orientText, isLandscape && styles.orientTextActive]}>Landscape</Text></TouchableOpacity>
               </View>
            </View>
            <View style={styles.settingsActions}>
               <TouchableOpacity style={styles.settingsCancelBtn} onPress={()=>setShowPdfSettings(false)}><Text style={styles.settingsCancelText}>Cancel</Text></TouchableOpacity>
               <TouchableOpacity style={styles.settingsGenerateBtn} onPress={handleGeneratePdf}><Text style={styles.settingsGenerateText}>Generate PDF</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { padding: 20, paddingTop: 45, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0', zIndex: 10 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B' },
  advancedBadge: { backgroundColor: '#EF4444', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 10 },
  advancedBadgeText: { color: '#FFF', fontSize: 10, fontWeight: 'bold' },
  searchContainer: { flexDirection: 'row', alignItems: 'center', width: '100%', height: 46, backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 14, marginBottom: 10 },
  searchInput: { flex: 1, minWidth: 0, height: '100%', marginLeft: 10, marginRight: 6, fontSize: 15, color: '#1E293B', paddingVertical: 0 },
  
  filterWrapper: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  filterScrollContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterBtn: { flexDirection: 'row', backgroundColor: '#F1F5F9', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  filterBtnActive: { backgroundColor: '#EFF6FF', borderColor: '#2563EB' },
  filterBtnText: { fontSize: 13, color: '#334155', fontWeight: 'bold', marginRight: 4 },
  filterBtnTextActive: { color: '#2563EB' },
  fixedClearBtn: { padding: 2, backgroundColor: '#FFF', borderRadius: 16 },
  
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#F1F5F9', paddingHorizontal: 15, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  sectionHeaderText: { fontSize: 14, fontWeight: 'bold', color: '#334155' },
  sectionCountText: { fontSize: 13, color: '#64748B', fontWeight: '600' },
  selectionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: '#BFDBFE',
  },
  selectionBarCount: { fontSize: 13, fontWeight: '800', color: '#1E3A8A' },
  selectionBarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectionActionBtn: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  selectionActionText: { fontSize: 12, fontWeight: '700', color: '#2563EB' },
  selectionCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FEF2F2',
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  selectionCancelText: { fontSize: 12, fontWeight: '700', color: '#EF4444', marginLeft: 3 },
  itemCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', padding: 15, marginHorizontal: 15, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  cardWithPhotos: { borderColor: '#10B981', backgroundColor: '#F0FDF4' },
  importedItemCard: { borderColor: '#EAB308', backgroundColor: '#FEFCE8' },
  itemCardSelected: { borderColor: '#2563EB', backgroundColor: '#EFF6FF', borderWidth: 2 },
  legacyItemCard: { borderColor: '#F59E0B', backgroundColor: '#FFFBEB' },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#CBD5E1', marginRight: 15, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF' },
  checkboxSelected: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  cardHeaderInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  itemTitle: { fontSize: 17, fontWeight: '700', color: '#1E293B', flex: 1, marginRight: 10 },
  cardSubRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  itemCode: { fontSize: 13, color: '#64748B', fontWeight: '500' },
  photoCountBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#D1FAE5', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  photoCountText: { fontSize: 12, fontWeight: 'bold', color: '#065F46' },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  cardDetail: { fontSize: 13, color: '#475569' },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyStateText: { marginTop: 10, color: '#94A3B8', fontSize: 16 },
  bottomToolbar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#FFF', borderTopWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 12, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, elevation: 15 },
  exportBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 11, paddingHorizontal: 8, borderRadius: 10 },
  exportBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 13 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  progressCard: { backgroundColor: '#FFF', padding: 30, borderRadius: 16, width: '85%', alignItems: 'center' },
  progressBarBg: { width: '100%', height: 12, backgroundColor: '#E2E8F0', borderRadius: 6, overflow: 'hidden', marginBottom: 10 },
  progressBarFill: { height: '100%', backgroundColor: '#10B981' },
  progressPercentText: { fontSize: 16, fontWeight: 'bold', color: '#10B981', marginBottom: 5 },
  progressText: { fontSize: 14, color: '#64748B', textAlign: 'center', marginBottom: 20 },
  stopBtn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, backgroundColor: '#FEF2F2' },
  stopBtnText: { color: '#EF4444', fontWeight: 'bold' },
  settingsCard: { backgroundColor: '#FFF', padding: 25, borderRadius: 16, width: '85%' },
  settingsTitle: { fontSize: 20, fontWeight: 'bold', color: '#1E293B', marginBottom: 20 },
  settingRow: { marginBottom: 20 },
  settingLabel: { fontSize: 14, fontWeight: 'bold', color: '#64748B', marginBottom: 8, textTransform: 'uppercase' },
  numInput: { backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', padding: 10, borderRadius: 8, fontSize: 16, width: 60, textAlign: 'center' },
  orientBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: '#F1F5F9', alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  orientBtnActive: { backgroundColor: '#EFF6FF', borderColor: '#2563EB' },
  orientText: { fontWeight: 'bold', color: '#64748B' },
  orientTextActive: { color: '#2563EB' },
  settingsActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10, gap: 15 },
  settingsCancelBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 8, backgroundColor: '#F1F5F9' },
  settingsCancelText: { color: '#64748B', fontWeight: 'bold' },
  settingsGenerateBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 8, backgroundColor: '#2563EB' },
  settingsGenerateText: { color: '#FFF', fontWeight: 'bold' },
  dropdownCard: { backgroundColor: '#FFF', width: '100%', borderRadius: 12, overflow: 'hidden', elevation: 5 },
  dropdownTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', padding: 15, borderBottomWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#F8FAFC', textAlign: 'center' },
  dropdownOption: { justifyContent: 'center', alignItems: 'center', padding: 15, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  dropdownOptionText: { fontSize: 16, color: '#475569', textAlign: 'center', width: '100%' },
  dropdownOptionSelectedText: { color: '#2563EB', fontWeight: 'bold' },
  dropdownCancelBtn: { padding: 15, alignItems: 'center', backgroundColor: '#FEF2F2' },
  dropdownCancelText: { color: '#EF4444', fontWeight: 'bold', fontSize: 15 },
  dropdownDoneBtn: { padding: 15, alignItems: 'center', backgroundColor: '#EFF6FF', borderTopWidth: 1, borderColor: '#E2E8F0' },
  dropdownDoneText: { color: '#2563EB', fontWeight: 'bold', fontSize: 15 },
  authorOptionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 18, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  authorCheckbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: '#CBD5E1', marginRight: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF' },
  authorOptionText: { fontSize: 15, color: '#334155', fontWeight: '600', flex: 1 },
  authorBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1 },
  authorBadgeYou: { backgroundColor: '#DCFCE7', borderColor: '#86EFAC' },
  authorBadgeImported: { backgroundColor: '#FEF3C7', borderColor: '#FDE047' },
  authorBadgeText: { fontSize: 11, fontWeight: '800' },
  authorBadgeTextYou: { color: '#166534' },
  authorBadgeTextImported: { color: '#92400E' }
});