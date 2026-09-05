import React, { useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SectionList, ActivityIndicator, Alert, Modal, TextInput, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as IntentLauncher from 'expo-intent-launcher';
import { generateZipArchive } from '../../utils/fileHelpers';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/appStore';

interface BeneficiaryItem {
  code: string;
  name: string;
  district_name: string;
  city_name: string;
  photo_count: number;
  sync_status: string;
  inspection_status: string;
  last_updated: string;
}

const SORT_OPTIONS = ['Name A-Z', 'Name Z-A', 'Inspection Pending', 'Recently Inspected'] as const;
type SortMode = typeof SORT_OPTIONS[number];

export default function DashboardScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { district, city, setFilters, clearFilters } = useAppStore();
  
  const [groupedData, setGroupedData] = useState<{title: string, dateObj: Date, data: BeneficiaryItem[]}[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  
  const [sortMode, setSortMode] = useState<SortMode>('Name A-Z');
  const [searchQuery, setSearchQuery] = useState('');
  
  const [uniqueDistricts, setUniqueDistricts] = useState<string[]>([]);
  const [uniqueCities, setUniqueCities] = useState<string[]>([]);
  const [activeDropdown, setActiveDropdown] = useState<'district' | 'city' | 'sort' | null>(null);

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

  const loadFilterOptions = useCallback(async () => {
    try {
      const dists = await db.getAllAsync<{district_name: string}>(`SELECT DISTINCT district_name FROM beneficiaries WHERE district_name IS NOT NULL AND district_name != '' ORDER BY district_name ASC`);
      setUniqueDistricts(dists.map(d => d.district_name));

      let cityQuery = `SELECT DISTINCT city_name FROM beneficiaries WHERE city_name IS NOT NULL AND city_name != ''`;
      const cityParams: string[] = [];
      if (district) { cityQuery += ` AND district_name = ?`; cityParams.push(district); }
      cityQuery += ` ORDER BY city_name ASC`;
      const cits = await db.getAllAsync<{city_name: string}>(cityQuery, cityParams);
      setUniqueCities(cits.map(c => c.city_name));
    } catch (error) {}
  }, [db, district]);

  const loadGroupedBeneficiaries = useCallback(async () => {
    setIsLoading(true);
    try {
      let query = `
        SELECT b.code, b.name, b.district_name, b.city_name, b.sync_status, b.inspection_status, MAX(p.created_at) as last_updated, COUNT(p.id) as photo_count
        FROM beneficiaries b
        INNER JOIN photos p ON b.code = p.beneficiary_code
        WHERE 1=1
      `;
      const params: any[] = [];

      if (searchQuery) {
        query += ` AND (b.name LIKE ? OR b.code LIKE ?)`;
        params.push(`%${searchQuery}%`, `%${searchQuery}%`);
      }
      if (district) {
        query += ` AND b.district_name = ?`;
        params.push(district);
      }
      if (city) {
        query += ` AND b.city_name = ?`;
        params.push(city);
      }

      query += ` GROUP BY b.code`;

      if (sortMode === 'Name A-Z') query += ` ORDER BY b.name ASC`;
      else if (sortMode === 'Name Z-A') query += ` ORDER BY b.name DESC`;
      else if (sortMode === 'Inspection Pending') query += ` ORDER BY CASE WHEN b.inspection_status = 'pending' THEN 0 ELSE 1 END, last_updated DESC`;
      else query += ` ORDER BY last_updated DESC`;

      const results = await db.getAllAsync<BeneficiaryItem>(query, params);

      const groups = results.reduce((acc: any, current) => {
        const dateObj = new Date(current.last_updated);
        const dateStr = !isNaN(dateObj.getTime()) 
          ? dateObj.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }) 
          : 'Unknown Date';

        if (!acc[dateStr]) acc[dateStr] = { title: dateStr, dateObj, data: [] };
        acc[dateStr].data.push(current);
        return acc;
      }, {});

      const formattedSections = Object.values(groups).sort((a: any, b: any) => b.dateObj.getTime() - a.dateObj.getTime()) as {title: string, dateObj: Date, data: BeneficiaryItem[]}[];
      setGroupedData(formattedSections);
    } catch (error) {
      console.error("Failed to load dashboard data", error);
    } finally {
      setIsLoading(false);
    }
  }, [db, searchQuery, district, city, sortMode]);

  useFocusEffect(
    useCallback(() => {
      loadFilterOptions();
      loadGroupedBeneficiaries();
    }, [loadFilterOptions, loadGroupedBeneficiaries])
  );

  const toggleSelection = (code: string) => setSelectedCodes(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);

  const toggleSection = (sectionData: BeneficiaryItem[]) => {
    const sectionCodes = sectionData.map(item => item.code);
    const allSelected = sectionCodes.every(code => selectedCodes.includes(code));
    if (allSelected) setSelectedCodes(prev => prev.filter(c => !sectionCodes.includes(c)));
    else setSelectedCodes(prev => Array.from(new Set([...prev, ...sectionCodes])));
  };

  const handleZipTrigger = async () => {
    if (selectedCodes.length === 0) return;
    const placeholders = selectedCodes.map(() => '?').join(',');
    const rows = await db.getAllAsync<{city_name: string}>(`SELECT city_name FROM beneficiaries WHERE code IN (${placeholders})`, selectedCodes);
    if (rows.some(r => !r.city_name || r.city_name.trim() === '')) {
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
      const zipUri = await generateZipArchive(db, selectedCodes, fallbackCityStr, (msg, pct) => {
        setProgressMsg(msg);
        setProgressPercent(pct);
      }, cancelRef.current);

      setIsProcessing(false);
      
      if (zipUri) {
        Alert.alert("ZIP Created", "Your file is ready. What would you like to do?", [
          { text: "Save to Device", onPress: async () => {
              const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
              if (permissions.granted) {
                const filename = zipUri.split('/').pop() || 'Export.zip';
                const destUri = await FileSystem.StorageAccessFramework.createFileAsync(permissions.directoryUri, filename, 'application/zip');
                const base64Data = await FileSystem.readAsStringAsync(zipUri, { encoding: FileSystem.EncodingType.Base64 });
                await FileSystem.writeAsStringAsync(destUri, base64Data, { encoding: FileSystem.EncodingType.Base64 });
                Alert.alert("Success", "ZIP saved to your selected folder.");
              }
          }},
          { text: "Share", onPress: () => Sharing.shareAsync(zipUri) },
          { text: "Cancel", style: "cancel" }
        ]);
        setSelectedCodes([]); 
      }
    } catch (e: any) {
      setIsProcessing(false);
      if (e.message !== "Cancelled by user") Alert.alert("Error", e.message);
    }
  };

  const handleGeneratePdf = async () => {
    setShowPdfSettings(false);
    setIsProcessing(true);
    setProgressPercent(0);
    cancelRef.current.current = false;
    setProgressMsg("Analyzing location data...");

    try {
      const placeholders = selectedCodes.map(() => '?').join(',');
      const query = `
        SELECT b.code, b.name, COALESCE(NULLIF(b.city_name, ''), 'Unknown_City') as assigned_city, MIN(p.created_at) as earliest_photo
        FROM beneficiaries b
        INNER JOIN photos p ON p.beneficiary_code = b.code
        WHERE b.code IN (${placeholders})
        GROUP BY b.code
        ORDER BY assigned_city ASC, earliest_photo ASC
      `;

      const beneficiaries = await db.getAllAsync<any>(query, selectedCodes);
      
      const groupedByCity: Record<string, any[]> = {};
      for (const b of beneficiaries) {
        if (!groupedByCity[b.assigned_city]) groupedByCity[b.assigned_city] = [];
        groupedByCity[b.assigned_city].push(b);
      }

      let pdfFilenameParts = [];
      let allCitiesData = [];
      let totalPhotosGlobal = 0;

      for (const city of Object.keys(groupedByCity)) {
        const cityBeneficiaries = groupedByCity[city];
        let cityPhotos = [];
        
        for (let i = 0; i < cityBeneficiaries.length; i++) {
          const b = cityBeneficiaries[i];
          const srNo = i + 1;
          const photos = await db.getAllAsync<any>(`SELECT * FROM photos WHERE beneficiary_code = ? ORDER BY created_at ASC`, [b.code]);

          for (let j = 0; j < photos.length; j++) {
            if (cancelRef.current.current) throw new Error("Cancelled by user");
            const photo = photos[j];
            setProgressMsg(`Compressing image ${totalPhotosGlobal + 1}...`);
            
            const manipResult = await ImageManipulator.manipulateAsync(
              photo.local_uri, [{ resize: { width: 800 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
            );

            const suffix = j === 0 ? '' : `_${j + 1}`;
            const caption = `${srNo}. ${b.name || ""}<br/>${b.code || ""}${suffix}`.trim();
            cityPhotos.push({ caption, base64: manipResult.base64 });
            totalPhotosGlobal++;
          }
        }
        if (cityPhotos.length > 0) {
          const safeName = city.replace(/[^a-zA-Z0-9]/g, '');
          pdfFilenameParts.push(`${safeName} - ${cityPhotos.length}`);
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
      const customUri = `${FileSystem.cacheDirectory}${pdfFilename}`;
      await FileSystem.moveAsync({ from: uri, to: customUri });

      setIsProcessing(false);
      
      Alert.alert("Success", "PDF created successfully!", [
          { text: "View", onPress: async () => {
             try {
                const cUri = await FileSystem.getContentUriAsync(customUri);
                await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: cUri, flags: 1, type: 'application/pdf' });
             } catch (e) { Alert.alert("Error", "No PDF Viewer installed on this device."); }
          }},
          { text: "Share", onPress: () => Sharing.shareAsync(customUri) },
          { text: "Cancel", style: "cancel" }
      ]);
      setSelectedCodes([]); 

    } catch (error: any) {
      setIsProcessing(false);
      if (error.message !== "Cancelled by user") Alert.alert("Failed", "Could not generate PDF document.");
    }
  };

  const renderDropdownModal = () => (
    <Modal visible={activeDropdown !== null} transparent animationType="fade">
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setActiveDropdown(null)}>
        <View style={styles.dropdownCard}>
          <Text style={styles.dropdownTitle}>
            {activeDropdown === 'district' ? 'Select District' : activeDropdown === 'city' ? 'Select City' : 'Sort By'}
          </Text>
          <ScrollView style={{ maxHeight: 300 }}>
            {activeDropdown === 'sort' && SORT_OPTIONS.map((opt) => (
              <TouchableOpacity key={opt} style={styles.dropdownOption} onPress={() => { setSortMode(opt); setActiveDropdown(null); }}>
                <Text style={[styles.dropdownOptionText, sortMode === opt && styles.dropdownOptionSelectedText]}>{opt}</Text>
              </TouchableOpacity>
            ))}
            {activeDropdown === 'district' && ['All Districts', ...uniqueDistricts].map((opt) => {
              const isSelected = district === opt || (!district && opt === 'All Districts');
              return (
                <TouchableOpacity key={opt} style={styles.dropdownOption} onPress={() => { setFilters(opt === 'All Districts' ? null : opt, null); setActiveDropdown(null); }}>
                  <Text style={[styles.dropdownOptionText, isSelected && styles.dropdownOptionSelectedText]}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
            {activeDropdown === 'city' && ['All Cities', ...uniqueCities].map((opt) => {
              const isSelected = city === opt || (!city && opt === 'All Cities');
              return (
                <TouchableOpacity key={opt} style={styles.dropdownOption} onPress={() => { setFilters(district, opt === 'All Cities' ? null : opt); setActiveDropdown(null); }}>
                  <Text style={[styles.dropdownOptionText, isSelected && styles.dropdownOptionSelectedText]}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TouchableOpacity style={styles.dropdownCancelBtn} onPress={() => setActiveDropdown(null)}>
            <Text style={styles.dropdownCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>Export Workspace</Text>
        </View>

        <View style={styles.searchContainer}>
          <Ionicons name="search" size={20} color="#94A3B8" />
          <TextInput style={styles.searchInput} placeholder="Search Application No. or Name..." value={searchQuery} onChangeText={setSearchQuery} />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Ionicons name="close-circle" size={20} color="#94A3B8" />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.filterBar}>
          <TouchableOpacity style={styles.filterBtn} onPress={() => setActiveDropdown('district')}>
            <Text style={styles.filterBtnText} numberOfLines={1}>{district || 'All Districts'}</Text>
            <Ionicons name="chevron-down" size={14} color="#64748B" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.filterBtn} onPress={() => setActiveDropdown('city')}>
            <Text style={styles.filterBtnText} numberOfLines={1}>{city || 'All Cities'}</Text>
            <Ionicons name="chevron-down" size={14} color="#64748B" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.filterBtn} onPress={() => setActiveDropdown('sort')}>
            <Ionicons name="swap-vertical" size={14} color="#64748B" style={{marginRight: 4}} />
            <Text style={styles.filterBtnText} numberOfLines={1}>{sortMode}</Text>
          </TouchableOpacity>
          {(district || city || sortMode !== 'Name A-Z') && (
            <TouchableOpacity onPress={() => { clearFilters(); setSortMode('Name A-Z'); setSearchQuery(''); }} style={styles.clearBtn}>
              <Ionicons name="close-circle" size={22} color="#EF4444" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#2563EB" style={{ marginTop: 50 }} />
      ) : (
        <SectionList
          sections={groupedData}
          keyExtractor={(item) => item.code}
          contentContainerStyle={{ paddingBottom: 120, paddingTop: 10 }} 
          renderSectionHeader={({ section: { title, data } }) => {
            const isAllSelected = data.every(item => selectedCodes.includes(item.code));
            return (
              <View style={styles.sectionHeader}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <TouchableOpacity style={[styles.checkbox, isAllSelected && styles.checkboxSelected, { width: 22, height: 22, marginRight: 10 }]} onPress={() => toggleSection(data)}>
                    {isAllSelected && <Ionicons name="checkmark" size={14} color="#FFF" />}
                  </TouchableOpacity>
                  <Text style={styles.sectionHeaderText}>{title}</Text>
                </View>
                <Text style={styles.sectionCountText}>{data.length} Projects</Text>
              </View>
            );
          }}
          renderItem={({ item }) => {
            const isSelected = selectedCodes.includes(item.code);
            return (
              <View style={[styles.itemCard, styles.cardWithPhotos, isSelected && styles.itemCardSelected]}>
                <TouchableOpacity style={[styles.checkbox, isSelected && styles.checkboxSelected]} onPress={() => toggleSelection(item.code)} hitSlop={{top: 15, bottom: 15, left: 10, right: 15}}>
                  {isSelected && <Ionicons name="checkmark" size={16} color="#FFF" />}
                </TouchableOpacity>
                <TouchableOpacity style={{ flex: 1 }} onPress={() => { if (selectedCodes.length > 0) toggleSelection(item.code); else router.push(`/beneficiary/${encodeURIComponent(item.code)}`); }} onLongPress={() => toggleSelection(item.code)}>
                  <View style={styles.cardHeaderInfo}>
                    <Text style={styles.itemTitle}>{item.name}</Text>
                  </View>
                  <View style={styles.cardSubRow}>
                    <View style={{flexDirection: 'row', alignItems: 'center'}}>
                      <Text style={styles.itemCode}>ID: {item.code}</Text>
                      {item.sync_status === 'pending' ? <Ionicons name="cloud-offline" size={18} color="#D97706" style={{ marginLeft: 6 }} /> : <Ionicons name="cloud-done" size={18} color="#059669" style={{ marginLeft: 6 }} />}
                    </View>
                    <View style={styles.photoCountBadge}>
                      <Ionicons name="images" size={12} color="#10B981" style={{ marginRight: 4 }} />
                      <Text style={styles.photoCountText}>{item.photo_count}</Text>
                    </View>
                  </View>
                  <View style={styles.cardFooter}>
                    <Text style={styles.cardDetail}><Ionicons name="location" size={14} color="#64748B" /> {item.city_name || 'N/A'}, {item.district_name || 'N/A'}</Text>
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
          <Text style={styles.selectedCountText}>{selectedCodes.length} Selected</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolbarActions}>
            <TouchableOpacity onPress={() => setSelectedCodes([])} style={{marginRight: 10}}>
              <Ionicons name="close-circle" size={36} color="#EF4444" />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.exportBtn, {backgroundColor: '#2563EB'}]} onPress={() => setShowPdfSettings(true)}>
              <Ionicons name="document-text" size={18} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={styles.exportBtnText}>PDF</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.exportBtn, {backgroundColor: '#10B981'}]} onPress={handleZipTrigger}>
              <Ionicons name="archive" size={18} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={styles.exportBtnText}>ZIP</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {renderDropdownModal()}

      <Modal visible={showCityPrompt} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>Missing City Names</Text>
            <Text style={{ fontSize: 14, color: '#64748B', marginBottom: 20, lineHeight: 20 }}>Please provide a fallback city name for proper grouping.</Text>
            <TextInput style={[styles.numInput, { width: '100%', textAlign: 'left', paddingHorizontal: 15, marginBottom: 20 }]} placeholder="e.g., Tharad" value={fallbackCity} onChangeText={setFallbackCity} />
            <View style={styles.settingsActions}>
               <TouchableOpacity style={styles.settingsCancelBtn} onPress={()=>setShowCityPrompt(false)}><Text style={styles.settingsCancelText}>Cancel</Text></TouchableOpacity>
               <TouchableOpacity style={styles.settingsGenerateBtn} onPress={() => startZipExport(fallbackCity)}><Text style={styles.settingsGenerateText}>Continue</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={isProcessing} transparent animationType="fade">
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

      <Modal visible={showPdfSettings} transparent animationType="slide">
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
  header: { padding: 20, paddingTop: 45, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B' },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 15, paddingVertical: 10, marginBottom: 10 },
  searchInput: { flex: 1, marginLeft: 10, marginRight: 5, fontSize: 16, color: '#1E293B' },
  filterBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterBtn: { flex: 1, flexDirection: 'row', backgroundColor: '#F1F5F9', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  filterBtnText: { fontSize: 13, color: '#334155', fontWeight: 'bold' },
  clearBtn: { padding: 2 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#F1F5F9', paddingHorizontal: 15, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  sectionHeaderText: { fontSize: 14, fontWeight: 'bold', color: '#334155' },
  sectionCountText: { fontSize: 13, color: '#64748B', fontWeight: '600' },
  itemCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', padding: 15, marginHorizontal: 15, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  cardWithPhotos: { borderColor: '#10B981', backgroundColor: '#F0FDF4' },
  itemCardSelected: { borderColor: '#2563EB', backgroundColor: '#EFF6FF', borderWidth: 2 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#CBD5E1', marginRight: 15, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF' },
  checkboxSelected: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  cardHeaderInfo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  itemTitle: { fontSize: 17, fontWeight: '700', color: '#1E293B', flex: 1, marginRight: 10 },
  cardSubRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  itemCode: { fontSize: 13, color: '#64748B', fontWeight: '500' },
  photoCountBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#D1FAE5', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  photoCountText: { fontSize: 12, fontWeight: 'bold', color: '#065F46' },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  cardDetail: { fontSize: 13, color: '#475569' },
  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyStateText: { marginTop: 10, color: '#94A3B8', fontSize: 16 },
  bottomToolbar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#FFF', borderTopWidth: 1, borderColor: '#E2E8F0', padding: 15, flexDirection: 'row', alignItems: 'center', elevation: 15 },
  selectedCountText: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginRight: 15 },
  toolbarActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  exportBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
  exportBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  selectAllBtn: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#EFF6FF', borderRadius: 8 },
  selectAllText: { color: '#2563EB', fontWeight: 'bold', fontSize: 13 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  progressCard: { backgroundColor: '#FFF', padding: 30, borderRadius: 16, width: '85%', alignItems: 'center' },
  progressTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 15 },
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
  dropdownCancelText: { color: '#EF4444', fontWeight: 'bold', fontSize: 15 }
});