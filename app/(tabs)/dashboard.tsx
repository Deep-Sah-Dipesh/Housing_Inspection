import React, { useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Modal, TextInput, Alert, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';

export default function DashboardScreen() {
  const router = useRouter();
  const db = useSQLiteContext();
  const [projects, setProjects] = useState<any[]>([]);
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  
  const [showExportModal, setShowExportModal] = useState(false);
  const [rows, setRows] = useState('2');
  const [cols, setCols] = useState('2');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');

  // Export Progress State
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const cancelExportRef = useRef(false);

  useFocusEffect(
    useCallback(() => { loadData(); }, [])
  );

  const loadData = async () => {
    try {
      const data = await db.getAllAsync(`
        SELECT b.*, COUNT(p.id) as photoCount 
        FROM beneficiaries b 
        LEFT JOIN photos p ON b.code = p.beneficiary_code 
        GROUP BY b.code
        ORDER BY b.last_updated DESC
      `);
      setProjects(data || []);
    } catch (e) {}
  };

  const handleItemPress = (code: string) => {
    if (isSelectionMode) toggleSelection(code);
    else router.push(`/beneficiary/${encodeURIComponent(code)}`);
  };

  const handleLongPress = (code: string) => {
    if (!isSelectionMode) {
      setIsSelectionMode(true);
      toggleSelection(code);
    }
  };

  const toggleSelection = (code: string) => {
    const newSet = new Set(selectedIds);
    newSet.has(code) ? newSet.delete(code) : newSet.add(code);
    setSelectedIds(newSet);
    if (newSet.size === 0) setIsSelectionMode(false);
  };

  const cancelSelection = () => {
    setSelectedIds(new Set());
    setIsSelectionMode(false);
  };

  const handleExportPDF = async () => {
    setShowExportModal(false);
    setIsExporting(true);
    setExportProgress(0);
    cancelExportRef.current = false;

    try {
      const placeholders = Array.from(selectedIds).map(() => '?').join(',');
      const photos = await db.getAllAsync<any>(
        `SELECT * FROM photos WHERE beneficiary_code IN (${placeholders}) ORDER BY beneficiary_code ASC, created_at ASC`,
        Array.from(selectedIds)
      );

      if (photos.length === 0) {
        setIsExporting(false);
        return Alert.alert("No Photos", "The selected beneficiaries have no photos.");
      }

      const r = parseInt(rows) || 2;
      const c = parseInt(cols) || 2;
      const photosPerPage = r * c;
      const pages = [];

      for (let i = 0; i < photos.length; i += photosPerPage) {
        pages.push(photos.slice(i, i + photosPerPage));
      }

      let html = `
        <html>
        <head>
          <style>
            @page { size: A4 ${orientation}; margin: 10mm; }
            body { margin: 0; font-family: sans-serif; background: #FFF; }
            .page { 
              width: 100%; 
              height: ${orientation === 'portrait' ? '277mm' : '190mm'}; 
              page-break-after: always; 
              display: grid; 
              grid-template-columns: repeat(${c}, 1fr); 
              grid-template-rows: repeat(${r}, 1fr); 
              gap: 10mm; 
              box-sizing: border-box;
            }
            .img-container { 
              display: flex; flex-direction: column; align-items: center; justify-content: center; 
              border: 1px solid #CBD5E1; padding: 5px; height: 100%; box-sizing: border-box; border-radius: 8px;
            }
            .img-container img { 
              max-width: 100%; max-height: calc(100% - 35px); object-fit: contain; border-radius: 4px;
            }
            .label { 
              margin-top: 8px; font-size: 11px; font-weight: bold; text-align: center; 
              word-wrap: break-word; max-width: 100%; line-height: 1.3; color: #1E293B;
            }
          </style>
        </head>
        <body>
      `;

      let totalProcessed = 0;

      for (let pIdx = 0; pIdx < pages.length; pIdx++) {
        if (cancelExportRef.current) throw new Error('CancelledByUser');
        
        const page = pages[pIdx];
        html += `<div class="page">`;
        
        for (let img of page) {
          if (cancelExportRef.current) throw new Error('CancelledByUser');

          // CRITICAL FIX: Shrink the image so the PDF generator doesn't crash from memory overload
          const compressedImg = await ImageManipulator.manipulateAsync(
            img.local_uri,
            [{ resize: { width: 800 } }], 
            { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );

          const cleanName = img.filename.replace(/\.[^/.]+$/, "");
          
          html += `
            <div class="img-container">
              <img src="data:image/jpeg;base64,${compressedImg.base64}" />
              <div class="label">${cleanName}</div>
            </div>
          `;
          
          totalProcessed++;
          setExportProgress((totalProcessed / photos.length) * 100);
        }
        html += `</div>`;
      }

      html += `</body></html>`;

      if (cancelExportRef.current) throw new Error('CancelledByUser');

      const { uri } = await Print.printToFileAsync({ html, base64: false });
      setIsExporting(false);
      
      // EXPLICIT INTENT LAUNCHER TO OPEN PDF DIRECTLY IN VIEWER
      if (Platform.OS === 'android') {
         try {
            const cUri = await FileSystem.getContentUriAsync(uri);
            await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
                data: cUri,
                flags: 1, 
                type: 'application/pdf'
            });
         } catch(e) {
            await Sharing.shareAsync(uri, { UTI: 'com.adobe.pdf', mimeType: 'application/pdf' });
         }
      } else {
         await Sharing.shareAsync(uri, { UTI: 'com.adobe.pdf', mimeType: 'application/pdf' });
      }

      cancelSelection();
    } catch (e: any) {
      setIsExporting(false);
      if (e.message !== 'CancelledByUser') {
        Alert.alert("Error", "Failed to generate PDF.");
      }
    }
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, isSelectionMode && { backgroundColor: '#EFF6FF' }]}>
        {isSelectionMode ? (
           <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
             <Text style={[styles.title, {color: '#2563EB'}]}>{selectedIds.size} Selected</Text>
             <TouchableOpacity onPress={cancelSelection}><Ionicons name="close-circle" size={28} color="#2563EB" /></TouchableOpacity>
           </View>
        ) : (
           <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
             <View>
               <Text style={styles.title}>Dashboard</Text>
               <Text style={styles.subtitle}>Select projects to export as PDF</Text>
             </View>
             <TouchableOpacity onPress={() => setIsSelectionMode(true)} style={styles.selectBtn}>
                <Text style={styles.selectBtnText}>Select</Text>
             </TouchableOpacity>
           </View>
        )}
      </View>

      <FlatList
        data={projects}
        keyExtractor={(item) => item.code}
        contentContainerStyle={{ padding: 15, paddingBottom: 100 }}
        renderItem={({ item }) => {
          const isSelected = selectedIds.has(item.code);
          return (
            <TouchableOpacity 
               style={[styles.card, isSelected && styles.cardSelected]} 
               onPress={() => handleItemPress(item.code)}
               onLongPress={() => handleLongPress(item.code)}
               delayLongPress={300}
            >
              <View style={{flex: 1}}>
                 <Text style={styles.cardCode}>{item.code}</Text>
                 {item.name ? <Text style={styles.cardName}>{item.name}</Text> : null}
              </View>
              <View style={{alignItems: 'flex-end'}}>
                 <Text style={[styles.photoCount, item.photoCount > 0 && {color: '#10B981'}]}>{item.photoCount} Photos</Text>
                 {isSelectionMode && (
                    <Ionicons name={isSelected ? "checkmark-circle" : "ellipse-outline"} size={24} color={isSelected ? "#2563EB" : "#CBD5E1"} style={{marginTop: 5}} />
                 )}
              </View>
            </TouchableOpacity>
          )
        }}
        ListEmptyComponent={
          <Text style={{textAlign: 'center', marginTop: 40, color: '#94A3B8'}}>No projects found.</Text>
        }
      />
      
      {isSelectionMode && selectedIds.size > 0 && (
        <TouchableOpacity style={styles.exportFab} onPress={() => setShowExportModal(true)}>
          <Ionicons name="document-text" size={24} color="#FFF" style={{marginRight: 10}}/>
          <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 16 }}>Export {selectedIds.size} Project(s)</Text>
        </TouchableOpacity>
      )}

      {/* Grid Settings Modal */}
      <Modal visible={showExportModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20}}>
               <Text style={styles.modalTitle}>A4 PDF Grid Layout</Text>
               <TouchableOpacity onPress={() => setShowExportModal(false)}><Ionicons name="close" size={24} color="#64748B"/></TouchableOpacity>
            </View>
            
            <View style={{flexDirection: 'row', gap: 15, marginBottom: 20}}>
               <View style={{flex: 1}}>
                  <Text style={styles.label}>Rows</Text>
                  <TextInput style={styles.input} placeholder="2" keyboardType="number-pad" value={rows} onChangeText={setRows} />
               </View>
               <View style={{flex: 1}}>
                  <Text style={styles.label}>Columns</Text>
                  <TextInput style={styles.input} placeholder="2" keyboardType="number-pad" value={cols} onChangeText={setCols} />
               </View>
            </View>

            <Text style={styles.label}>Page Orientation</Text>
            <View style={{flexDirection: 'row', gap: 15, marginBottom: 25}}>
              <TouchableOpacity style={[styles.orientationBtn, orientation === 'portrait' && styles.orientationBtnActive]} onPress={() => setOrientation('portrait')}>
                <Text style={[styles.orientationBtnText, orientation === 'portrait' && styles.orientationBtnTextActive]}>Portrait</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.orientationBtn, orientation === 'landscape' && styles.orientationBtnActive]} onPress={() => setOrientation('landscape')}>
                <Text style={[styles.orientationBtnText, orientation === 'landscape' && styles.orientationBtnTextActive]}>Landscape</Text>
              </TouchableOpacity>
            </View>
            
            <TouchableOpacity style={styles.primaryBtn} onPress={handleExportPDF}>
              <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 16, textAlign: 'center' }}>Generate PDF</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Progress Overlay */}
      <Modal visible={isExporting} transparent animationType="fade">
        <View style={styles.progressOverlay}>
          <View style={styles.progressCard}>
            <ActivityIndicator size="large" color="#2563EB" style={{marginBottom: 15}} />
            <Text style={styles.progressTitle}>Generating PDF...</Text>
            <Text style={styles.progressSubtitle}>Optimizing & Compiling Images</Text>
            
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${exportProgress}%` }]} />
            </View>
            <Text style={styles.progressPercent}>{Math.round(exportProgress)}%</Text>

            <TouchableOpacity style={styles.cancelBtn} onPress={() => { cancelExportRef.current = true; setIsExporting(false); }}>
              <Text style={styles.cancelBtnText}>Cancel Export</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B' },
  subtitle: { fontSize: 13, color: '#64748B', marginTop: 4 },
  selectBtn: { backgroundColor: '#F1F5F9', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20 },
  selectBtnText: { color: '#2563EB', fontWeight: 'bold' },
  card: { flexDirection: 'row', backgroundColor: '#FFF', padding: 20, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', elevation: 1 },
  cardSelected: { borderColor: '#2563EB', backgroundColor: '#EFF6FF', borderWidth: 2 },
  cardCode: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  cardName: { fontSize: 14, color: '#475569', marginTop: 4 },
  photoCount: { fontSize: 14, fontWeight: 'bold', color: '#94A3B8' },
  exportFab: { position: 'absolute', bottom: 30, left: 30, right: 30, backgroundColor: '#2563EB', flexDirection: 'row', padding: 18, borderRadius: 16, justifyContent: 'center', alignItems: 'center', elevation: 5 },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', padding: 25, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#1E293B' },
  label: { fontSize: 12, fontWeight: 'bold', color: '#64748B', marginBottom: 8, textTransform: 'uppercase' },
  input: { backgroundColor: '#F8FAFC', padding: 15, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', fontSize: 18, textAlign: 'center', fontWeight: 'bold' },
  orientationBtn: { flex: 1, padding: 15, borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', alignItems: 'center', backgroundColor: '#F8FAFC' },
  orientationBtnActive: { borderColor: '#2563EB', backgroundColor: '#EFF6FF' },
  orientationBtnText: { fontWeight: 'bold', color: '#64748B' },
  orientationBtnTextActive: { color: '#2563EB' },
  primaryBtn: { backgroundColor: '#2563EB', padding: 16, borderRadius: 12, alignItems: 'center' },

  progressOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  progressCard: { backgroundColor: '#FFF', width: '100%', maxWidth: 350, padding: 30, borderRadius: 20, alignItems: 'center' },
  progressTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 5 },
  progressSubtitle: { fontSize: 13, color: '#64748B', marginBottom: 20 },
  progressBarBg: { width: '100%', height: 8, backgroundColor: '#E2E8F0', borderRadius: 4, overflow: 'hidden', marginBottom: 10 },
  progressBarFill: { height: '100%', backgroundColor: '#2563EB' },
  progressPercent: { fontSize: 14, fontWeight: 'bold', color: '#1E293B', marginBottom: 20 },
  cancelBtn: { padding: 12, width: '100%', alignItems: 'center', backgroundColor: '#FEF2F2', borderRadius: 10 },
  cancelBtnText: { color: '#EF4444', fontWeight: 'bold' }
});