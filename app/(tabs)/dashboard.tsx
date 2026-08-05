import React, { useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SectionList, ActivityIndicator, Alert, Modal, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as ImageManipulator from 'expo-image-manipulator';
import { exportProjects } from '../../utils/fileHelpers';

interface BeneficiaryItem {
  code: string;
  name: string;
  photo_count: number;
  last_updated: string;
}

export default function DashboardScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const [groupedData, setGroupedData] = useState<{title: string, data: BeneficiaryItem[]}[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);

  // PDF Export States
  const [showPdfSettings, setShowPdfSettings] = useState(false);
  const [pdfRows, setPdfRows] = useState('2');
  const [pdfCols, setPdfCols] = useState('2');
  const [isLandscape, setIsLandscape] = useState(false);
  
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfProgressMsg, setPdfProgressMsg] = useState('');
  const cancelPdfRef = useRef(false);

  // File Export States with Progress Bar Support
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgressMsg, setExportProgressMsg] = useState('');
  const [exportProgressPercent, setExportProgressPercent] = useState(0);
  const cancelExportRef = useRef({ current: false });

  useFocusEffect(
    useCallback(() => {
      loadGroupedBeneficiaries();
    }, [])
  );

  const loadGroupedBeneficiaries = async () => {
    setIsLoading(true);
    try {
      const results = await db.getAllAsync<BeneficiaryItem>(`
        SELECT b.code, b.name, b.last_updated, COUNT(p.id) as photo_count
        FROM beneficiaries b
        LEFT JOIN photos p ON b.code = p.beneficiary_code
        GROUP BY b.code
        ORDER BY b.last_updated DESC
      `);

      const groups = results.reduce((acc: any, current) => {
        const dateObj = new Date(current.last_updated);
        const dateStr = !isNaN(dateObj.getTime()) 
          ? dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) 
          : 'Unknown Date';

        if (!acc[dateStr]) acc[dateStr] = [];
        acc[dateStr].push(current);
        return acc;
      }, {});

      const formattedSections = Object.keys(groups).map(date => ({
        title: date,
        data: groups[date]
      }));

      setGroupedData(formattedSections);
    } catch (error) {
      console.error("Failed to load dashboard data", error);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSelection = (code: string) => {
    if (selectedCodes.includes(code)) {
      setSelectedCodes(prev => prev.filter(c => c !== code));
    } else {
      setSelectedCodes(prev => [...prev, code]);
    }
  };

  const toggleSection = (sectionData: BeneficiaryItem[]) => {
    const sectionCodes = sectionData.map(item => item.code);
    const allSelected = sectionCodes.every(code => selectedCodes.includes(code));
    
    if (allSelected) {
      // Remove all codes in this date section
      setSelectedCodes(prev => prev.filter(c => !sectionCodes.includes(c)));
    } else {
      // Add all codes in this date section
      setSelectedCodes(prev => Array.from(new Set([...prev, ...sectionCodes])));
    }
  };

  const handleSelectAll = () => {
    if (selectedCodes.length > 0) {
      setSelectedCodes([]);
    } else {
      const allCodes = groupedData.flatMap(section => section.data.map(item => item.code));
      setSelectedCodes(allCodes);
    }
  };

  const handleBulkZipExport = () => {
    if (selectedCodes.length === 0) return;
    
    Alert.alert(
      "Export Projects",
      "Would you like to compress them into a ZIP for sharing, or save the ZIP folder just to your device?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Share as ZIP", 
          onPress: async () => {
            setIsExporting(true);
            setExportProgressPercent(0);
            cancelExportRef.current.current = false;
            await exportProjects(selectedCodes, 'share', (msg, pct) => {
               setExportProgressMsg(msg);
               setExportProgressPercent(pct);
            }, cancelExportRef.current);
            setIsExporting(false);
            if (!cancelExportRef.current.current) setSelectedCodes([]); 
          }
        },
        { 
          text: "Save to Device", 
          onPress: async () => {
            setIsExporting(true);
            setExportProgressPercent(0);
            cancelExportRef.current.current = false;
            await exportProjects(selectedCodes, 'save', (msg, pct) => {
               setExportProgressMsg(msg);
               setExportProgressPercent(pct);
            }, cancelExportRef.current);
            setIsExporting(false);
            if (!cancelExportRef.current.current) setSelectedCodes([]); 
          }
        }
      ]
    );
  };

  const handleGeneratePdf = async () => {
    setShowPdfSettings(false);
    setIsGeneratingPdf(true);
    cancelPdfRef.current = false;
    setPdfProgressMsg("Preparing selected projects...");

    try {
      const placeholders = selectedCodes.map(() => '?').join(',');
      const photos = await db.getAllAsync<any>(
        `SELECT * FROM photos WHERE beneficiary_code IN (${placeholders}) ORDER BY created_at ASC`,
        selectedCodes
      );

      if (photos.length === 0) {
        Alert.alert("No Data", "None of the selected projects contain photos.");
        setIsGeneratingPdf(false);
        return;
      }

      let processedPhotos = [];
      for (let i = 0; i < photos.length; i++) {
        if (cancelPdfRef.current) throw new Error("Cancelled by user");
        
        setPdfProgressMsg(`Compressing image ${i + 1} of ${photos.length}...`);
        const manipResult = await ImageManipulator.manipulateAsync(
          photos[i].local_uri,
          [{ resize: { width: 800 } }],
          { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
        );

        processedPhotos.push({
          filename: photos[i].filename,
          base64: manipResult.base64
        });
      }

      setPdfProgressMsg("Formatting A4 PDF Document...");
      
      const rows = parseInt(pdfRows) || 2;
      const cols = parseInt(pdfCols) || 2;
      const itemsPerPage = rows * cols;
      let pagesHtml = '';

      for (let i = 0; i < processedPhotos.length; i += itemsPerPage) {
        if (cancelPdfRef.current) throw new Error("Cancelled by user");
        const chunk = processedPhotos.slice(i, i + itemsPerPage);
        
        pagesHtml += `<div class="page">`;
        chunk.forEach(photo => {
          const caption = photo.filename.replace(/\.[^/.]+$/, "");
          pagesHtml += `
            <div class="img-cell">
              <img src="data:image/jpeg;base64,${photo.base64}" />
              <div class="caption">${caption}</div>
            </div>
          `;
        });
        pagesHtml += `</div>`;
      }

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
              page-break-after: always;
              padding: 10mm;
              box-sizing: border-box;
              display: grid;
              grid-template-columns: repeat(${cols}, 1fr);
              grid-template-rows: repeat(${rows}, 1fr);
              gap: 10mm;
            }
            .img-cell { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; overflow: hidden; }
            .img-cell img { max-width: 100%; max-height: 85%; object-fit: contain; border: 1px solid #CBD5E1; border-radius: 4px; }
            .caption { margin-top: 8px; font-size: 11px; color: #1E293B; text-align: center; word-wrap: break-word; max-width: 100%; line-height: 1.4; }
          </style>
        </head>
        <body>
          ${pagesHtml}
        </body>
        </html>
      `;

      const { uri } = await Print.printToFileAsync({ html });
      await Sharing.shareAsync(uri, { UTI: 'com.adobe.pdf', mimeType: 'application/pdf' });
      setSelectedCodes([]); 
    } catch (error: any) {
      if (error.message !== "Cancelled by user") Alert.alert("Export Failed", "Could not generate PDF document.");
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#2563EB" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={{flex: 1}}>
           <Text style={styles.title}>Export Dashboard</Text>
           <Text style={styles.headerSubtitle}>
             {selectedCodes.length === 0 ? "No projects selected" : `${selectedCodes.length} Project${selectedCodes.length > 1 ? 's' : ''} Selected for Export`}
           </Text>
        </View>
        <TouchableOpacity style={styles.selectAllBtn} onPress={handleSelectAll}>
          <Text style={styles.selectAllText}>
            {selectedCodes.length > 0 ? 'Deselect All' : 'Select All'}
          </Text>
        </TouchableOpacity>
      </View>

      <SectionList
        sections={groupedData}
        keyExtractor={(item) => item.code}
        contentContainerStyle={{ paddingBottom: 120 }} 
        renderSectionHeader={({ section: { title, data } }) => {
          const isAllSelected = data.every(item => selectedCodes.includes(item.code));
          return (
            <TouchableOpacity 
              style={styles.sectionHeader} 
              activeOpacity={0.7} 
              onPress={() => toggleSection(data)}
            >
              <View style={[styles.checkbox, isAllSelected && styles.checkboxSelected, { width: 20, height: 20, marginRight: 10 }]}>
                {isAllSelected && <Ionicons name="checkmark" size={14} color="#FFF" />}
              </View>
              <Text style={styles.sectionHeaderText}>{title}</Text>
              <Text style={styles.sectionCountText}>{data.length} Projects</Text>
            </TouchableOpacity>
          );
        }}
        renderItem={({ item }) => {
          const isSelected = selectedCodes.includes(item.code);
          return (
            <View style={[styles.itemCard, isSelected && styles.itemCardSelected]}>
              <TouchableOpacity 
                style={[styles.checkbox, isSelected && styles.checkboxSelected]}
                onPress={() => toggleSelection(item.code)}
                hitSlop={{top: 15, bottom: 15, left: 10, right: 15}}
              >
                {isSelected && <Ionicons name="checkmark" size={16} color="#FFF" />}
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={{ flex: 1 }}
                onPress={() => {
                  if (selectedCodes.length > 0) toggleSelection(item.code);
                  else router.push(`/beneficiary/${encodeURIComponent(item.code)}`);
                }}
                onLongPress={() => toggleSelection(item.code)}
              >
                <Text style={styles.itemTitle}>{item.name || 'Unnamed Project'}</Text>
                <Text style={styles.itemCode}>ID: {item.code}</Text>
              </TouchableOpacity>

              <View style={styles.photoCountBadge}>
                <Ionicons name="image" size={12} color="#64748B" style={{ marginRight: 4 }} />
                <Text style={styles.photoCountText}>{item.photo_count}</Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="folder-open-outline" size={50} color="#CBD5E1" />
            <Text style={styles.emptyStateText}>No projects found to export.</Text>
          </View>
        }
      />

      {selectedCodes.length > 0 && (
        <View style={styles.bottomToolbar}>
          <Text style={styles.selectedCountText}>{selectedCodes.length} Selected</Text>
          
          <View style={styles.toolbarActions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setSelectedCodes([])} disabled={isExporting}>
              <Text style={styles.cancelBtnText}>Clear</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.exportBtn, {backgroundColor: '#2563EB'}]} onPress={() => setShowPdfSettings(true)}>
              <Ionicons name="document-text" size={18} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={styles.exportBtnText}>PDF</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.exportBtn} onPress={handleBulkZipExport}>
              <Ionicons name="folder-open" size={18} color="#FFF" style={{ marginRight: 6 }} />
              <Text style={styles.exportBtnText}>Files</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Real Progress Bar Modal */}
      <Modal visible={isExporting} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.progressCard}>
            <Text style={styles.progressTitle}>Saving to Device...</Text>
            
            <View style={styles.progressBarBg}>
               <View style={[styles.progressBarFill, { width: `${exportProgressPercent}%` }]} />
            </View>
            
            <Text style={styles.progressPercentText}>{exportProgressPercent}%</Text>
            <Text style={styles.progressText}>{exportProgressMsg}</Text>
            
            <TouchableOpacity style={styles.stopBtn} onPress={() => {
              cancelExportRef.current.current = true;
              setIsExporting(false);
            }}>
              <Text style={styles.stopBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={isGeneratingPdf} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.progressCard}>
            <ActivityIndicator size="large" color="#2563EB" style={{ marginBottom: 15 }} />
            <Text style={styles.progressText}>{pdfProgressMsg}</Text>
            <TouchableOpacity style={styles.stopBtn} onPress={() => {
              cancelPdfRef.current = true;
              setIsGeneratingPdf(false);
            }}>
              <Text style={styles.stopBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showPdfSettings} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsTitle}>PDF Export Settings</Text>
            
            <View style={styles.settingRow}>
               <Text style={styles.settingLabel}>Images Per Page (Grid)</Text>
               <View style={{flexDirection: 'row', alignItems: 'center', gap: 10}}>
                  <TextInput style={styles.numInput} value={pdfRows} onChangeText={setPdfRows} keyboardType="numeric" maxLength={1} selectTextOnFocus />
                  <Text style={{fontWeight: 'bold', color: '#64748B'}}>Rows x</Text>
                  <TextInput style={styles.numInput} value={pdfCols} onChangeText={setPdfCols} keyboardType="numeric" maxLength={1} selectTextOnFocus />
                  <Text style={{fontWeight: 'bold', color: '#64748B'}}>Cols</Text>
               </View>
            </View>

            <View style={styles.settingRow}>
               <Text style={styles.settingLabel}>Page Orientation</Text>
               <View style={{flexDirection: 'row', gap: 10}}>
                 <TouchableOpacity style={[styles.orientBtn, !isLandscape && styles.orientBtnActive]} onPress={()=>setIsLandscape(false)}>
                    <Text style={[styles.orientText, !isLandscape && styles.orientTextActive]}>Portrait</Text>
                 </TouchableOpacity>
                 <TouchableOpacity style={[styles.orientBtn, isLandscape && styles.orientBtnActive]} onPress={()=>setIsLandscape(true)}>
                    <Text style={[styles.orientText, isLandscape && styles.orientTextActive]}>Landscape</Text>
                 </TouchableOpacity>
               </View>
            </View>

            <View style={styles.settingsActions}>
               <TouchableOpacity style={styles.settingsCancelBtn} onPress={()=>setShowPdfSettings(false)}>
                 <Text style={styles.settingsCancelText}>Cancel</Text>
               </TouchableOpacity>
               <TouchableOpacity style={styles.settingsGenerateBtn} onPress={handleGeneratePdf}>
                 <Text style={styles.settingsGenerateText}>Generate PDF</Text>
               </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B' },
  headerSubtitle: { fontSize: 13, fontWeight: 'bold', color: '#10B981', marginTop: 4 },
  selectAllBtn: { paddingVertical: 6, paddingHorizontal: 12, backgroundColor: '#EFF6FF', borderRadius: 8 },
  selectAllText: { color: '#2563EB', fontWeight: 'bold', fontSize: 13 },
  
  sectionHeader: { backgroundColor: '#F1F5F9', paddingHorizontal: 15, paddingVertical: 12, marginTop: 10, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  sectionHeaderText: { fontSize: 15, fontWeight: 'bold', color: '#334155' },
  sectionCountText: { marginLeft: 'auto', fontSize: 13, color: '#64748B', fontWeight: '600' },
  
  itemCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF', padding: 15, marginHorizontal: 15, marginTop: 10, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  itemCardSelected: { borderColor: '#2563EB', backgroundColor: '#EFF6FF' },
  
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#CBD5E1', marginRight: 15, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF' },
  checkboxSelected: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  
  itemTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E293B' },
  itemCode: { fontSize: 13, color: '#64748B', marginTop: 2 },
  
  photoCountBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  photoCountText: { fontSize: 12, fontWeight: 'bold', color: '#64748B' },

  emptyState: { alignItems: 'center', marginTop: 60 },
  emptyStateText: { marginTop: 10, color: '#94A3B8', fontSize: 16 },

  bottomToolbar: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#FFF', borderTopWidth: 1, borderColor: '#E2E8F0', padding: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', elevation: 15, shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.1, shadowRadius: 10 },
  selectedCountText: { fontSize: 16, fontWeight: 'bold', color: '#1E293B' },
  toolbarActions: { flexDirection: 'row', gap: 10 },
  cancelBtn: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#F1F5F9' },
  cancelBtnText: { color: '#64748B', fontWeight: 'bold', fontSize: 14 },
  exportBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, backgroundColor: '#10B981' },
  exportBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
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
  settingsGenerateText: { color: '#FFF', fontWeight: 'bold' }
});