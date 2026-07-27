import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Image, Modal, Alert, TextInput, Dimensions, KeyboardAvoidingView, Platform, ActivityIndicator, TouchableWithoutFeedback } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import ViewShot from 'react-native-view-shot';
import * as ImageManipulator from 'expo-image-manipulator';
import { Accelerometer } from 'expo-sensors';
import { generatePhotoFilename } from '../../utils/fileHelpers';
import { GOOGLE_MAPS_API_KEY } from '../../utils/firebaseConfig';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const COLUMN_COUNT = 2;
const IMAGE_MARGIN = 5;
const IMAGE_SIZE = (SCREEN_WIDTH - 30 - (IMAGE_MARGIN * 2 * COLUMN_COUNT)) / COLUMN_COUNT;

const ZOOM_STEPS = [0, 0.15, 0.3, 0.5, 0.75, 1.0];
const ZOOM_LABELS = ['1x', '1.5x', '2x', '3x', '4x', '5x'];

const formatGeoDate = (d: Date) => {
  const p = (n: number) => n.toString().padStart(2, '0');
  const h12 = d.getHours() % 12 || 12;
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const offH = p(Math.floor(Math.abs(offset) / 60));
  const offM = p(Math.abs(offset) % 60);
  const yy = d.getFullYear().toString().slice(-2);
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${yy} ${p(h12)}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ampm} GMT ${sign}${offH}:${offM}`;
};

// Memoized Header Component to prevent TextInput focus loss
const BeneficiaryHeader = React.memo(({ beneficiary, id, photosCount, noteContent, setNoteContent, isEditingNote, setIsEditingNote, saveNote }: any) => (
  <View style={styles.headerContainer}>
    <View style={styles.detailsCard}>
      <View style={styles.detailsHeader}>
        <View style={styles.avatarCircle}>
           <Ionicons name="person" size={28} color="#2563EB" />
        </View>
        <View style={styles.detailsHeaderText}>
          <Text style={styles.beneficiaryName}>{beneficiary?.name || 'Name not provided'}</Text>
          <Text style={styles.beneficiaryCode}>ID: {id}</Text>
        </View>
      </View>
      
      {/* 3-Item Grid replacing Mobile Number with Sync Status */}
      <View style={styles.detailsGrid}>
        <View style={styles.detailItem}>
          <Text style={styles.detailLabel}>Serial No.</Text>
          <Text style={styles.detailValue}>{beneficiary?.serial_number || '--'}</Text>
        </View>
        <View style={styles.detailItem}>
          <Text style={styles.detailLabel}>Photos</Text>
          <Text style={styles.detailValue}>{photosCount}</Text>
        </View>
        <View style={styles.detailItem}>
          <Text style={styles.detailLabel}>Sync Status</Text>
          <Text style={[styles.detailValue, { color: beneficiary?.sync_status === 'synced' ? '#10B981' : '#F59E0B' }]}>
            {beneficiary?.sync_status === 'synced' ? 'Cloud Synced' : 'Local Draft'}
          </Text>
        </View>
      </View>
    </View>

    <View style={styles.notesContainer}>
      <Text style={styles.sectionTitle}>Inspection Notes</Text>
      {isEditingNote ? (
        <View>
          <TextInput 
            style={styles.notesInput}
            placeholder="Add site observations, status, or issues here..."
            placeholderTextColor="#94A3B8"
            multiline
            autoFocus
            numberOfLines={4}
            value={noteContent}
            onChangeText={setNoteContent}
            textAlignVertical="top"
          />
          <TouchableOpacity style={styles.saveNoteBtn} onPress={saveNote}>
            <Text style={{color: '#FFF', fontWeight: 'bold'}}>Save Note</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity 
          style={[styles.notesInput, { minHeight: 80, justifyContent: noteContent ? 'flex-start' : 'center' }]} 
          onLongPress={() => setIsEditingNote(true)}
          activeOpacity={0.7}
        >
          <Text style={{ color: noteContent ? '#1E293B' : '#94A3B8', fontStyle: noteContent ? 'normal' : 'italic' }}>
            {noteContent || "No saved notes found yet. Tap the pen icon to add."}
          </Text>
        </TouchableOpacity>
      )}
    </View>

    <Text style={[styles.sectionTitle, { paddingHorizontal: 15, marginBottom: 10 }]}>Gallery ({photosCount})</Text>
  </View>
));

export default function BeneficiaryAlbumScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const db = useSQLiteContext();
  
  const [beneficiary, setBeneficiary] = useState<any>(null);
  const [photos, setPhotos] = useState<any[]>([]);
  const [imageRefreshKey, setImageRefreshKey] = useState(Date.now());
  
  const [noteContent, setNoteContent] = useState('');
  const [isEditingNote, setIsEditingNote] = useState(false);
  
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
  const zoomTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastZoomTap = useRef<number>(0);
  
  const [liveGeoData, setLiveGeoData] = useState<any>(null);
  const [captureQueue, setCaptureQueue] = useState<any[]>([]);
  const [captureTrigger, setCaptureTrigger] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);

  const noteFilename = generatePhotoFilename(beneficiary?.serial_number, beneficiary?.name, id as string, 0).replace('_1.jpg', '_Notes.txt');
  const targetDir = `${FileSystem.documentDirectory}HousingInspection/${id}/`;

  useEffect(() => { loadData(); }, [id]);

  useEffect(() => {
    if (!showCamera) return;
    const subscription = Accelerometer.addListener(({ x, y }) => {
        if (Math.abs(x) > Math.abs(y)) setDeviceOrientation(x > 0 ? -90 : 90);
        else setDeviceOrientation(y > 0 ? 0 : 180);
    });
    Accelerometer.setUpdateInterval(300);
    return () => subscription.remove();
  }, [showCamera]);

  const loadData = async () => {
    try {
      const bData = await db.getFirstAsync(`SELECT * FROM beneficiaries WHERE code = ?`, [id]);
      setBeneficiary(bData);
      
      const pData = await db.getAllAsync(`SELECT * FROM photos WHERE beneficiary_code = ? ORDER BY created_at DESC`, [id]);
      setPhotos(pData || []);

      const notePath = `${targetDir}${noteFilename}`;
      const noteInfo = await FileSystem.getInfoAsync(notePath);
      if (noteInfo.exists) {
         const content = await FileSystem.readAsStringAsync(notePath);
         setNoteContent(content);
      }
    } catch (error) {}
  };

  const saveNote = async () => {
    setIsEditingNote(false);
    try {
      await FileSystem.makeDirectoryAsync(targetDir, { intermediates: true });
      const notePath = `${targetDir}${noteFilename}`;
      await FileSystem.writeAsStringAsync(notePath, noteContent.trim());
    } catch (error) {
      Alert.alert("Error", "Could not save notes.");
    }
  };

  useEffect(() => {
    let sub: Location.LocationSubscription;
    if (showCamera) {
      (async () => {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          sub = await Location.watchPositionAsync({
              accuracy: Location.Accuracy.Balanced,
              timeInterval: 5000, distanceInterval: 0
          },
          async (loc) => {
            try {
              const geocode = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
              const addr = geocode[0] || {};
              const detailedAddress = [addr.street, addr.subregion, addr.city, addr.region, addr.postalCode, addr.country].filter(Boolean).join(', ');
              
              setLiveGeoData({
                lat: loc.coords.latitude.toFixed(6), 
                lon: loc.coords.longitude.toFixed(6), 
                address: detailedAddress || 'Unknown Location', 
                city: addr.city || addr.subregion || 'Unknown City', 
                region: addr.region || 'Unknown Region',
                country: addr.country || 'India',
                timestamp: formatGeoDate(new Date(loc.timestamp)) // Standard start time
              });
            } catch (e) {}
          });
        }
      })();
    }
    return () => { if (sub) sub.remove(); }
  }, [showCamera]);

  const openCamera = async () => {
    if (!permission?.granted) await requestPermission();
    await Location.requestForegroundPermissionsAsync();
    setZoomIndex(0);
    setShowCamera(true);
  };

  const captureLiveMedia = async () => {
    if (!cameraRef || isCapturing) return;
    try {
      setIsCapturing(true);
      const photo = await cameraRef.takePictureAsync({ quality: 0.85 });
      if (!photo) return;

      const currentGeo = liveGeoData || { lat: "0.000000", lon: "0.000000", address: "Locating...", city: "", region: "", country: "", timestamp: formatGeoDate(new Date()) };
      
      setCaptureQueue(q => [...q, { 
          id: Date.now(), 
          uri: photo.uri, 
          // Freeze exact time of capture
          geoData: { ...currentGeo, timestamp: formatGeoDate(new Date()) }, 
          orientation: deviceOrientation,
          aspectRatio,
          photoWidth: photo.width,
          photoHeight: photo.height
      }]);

      setShowCamera(false);
    } catch (e) {
    } finally {
      setIsCapturing(false);
    }
  };

  useEffect(() => {
    if (captureTrigger > 0 && captureQueue.length > 0 && viewShotRef.current) {
      // 500ms delay ensures image is completely loaded into the invisible canvas before snapping
      setTimeout(async () => {
        try {
          const stampedUri = await viewShotRef.current?.capture?.();
          if (stampedUri) {
             const filename = generatePhotoFilename(beneficiary?.serial_number, beneficiary?.name, id as string, photos.length);
             await FileSystem.makeDirectoryAsync(targetDir, { intermediates: true });
             
             const newUri = `${targetDir}${filename}`;
             await FileSystem.copyAsync({ from: stampedUri, to: newUri });

             await db.runAsync(
               `INSERT INTO photos (id, beneficiary_code, local_uri, filename, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)`,
               [captureQueue[0].id.toString(), id as string, newUri, filename, captureQueue[0].geoData.lat, captureQueue[0].geoData.lon]
             );
             setImageRefreshKey(Date.now());
             loadData();
          }
        } catch (e) {
        } finally {
          setCaptureQueue(q => q.slice(1));
          setCaptureTrigger(0);
        }
      }, 500); 
    }
  }, [captureTrigger, captureQueue]);

  const handleZoomTap = () => {
    const now = Date.now();
    if (now - lastZoomTap.current < 300) {
      setZoomIndex(0); setShowZoom(false);
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    } else {
      setShowZoom(!showZoom);
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
      if (!showZoom) zoomTimeoutRef.current = setTimeout(() => setShowZoom(false), 3000);
    }
    lastZoomTap.current = now;
  };

  const changeZoom = (delta: number) => {
    setZoomIndex(z => Math.max(0, Math.min(ZOOM_STEPS.length - 1, z + delta)));
    if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
    zoomTimeoutRef.current = setTimeout(() => setShowZoom(false), 3000);
  };

  const deletePhoto = async (photoId: string, uri: string) => {
    Alert.alert("Delete Photo", "Are you sure you want to delete this image?", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
          try {
            await FileSystem.deleteAsync(uri, { idempotent: true });
            await db.runAsync(`DELETE FROM photos WHERE id = ?`, [photoId]);
            setViewerIndex(null);
            loadData();
          } catch (e) {}
      }}
    ]);
  };

  const rotatePhoto = async (photo: any, direction: 'left' | 'right') => {
    try {
      const angle = direction === 'right' ? 90 : -90;
      const manipResult = await ImageManipulator.manipulateAsync(
        photo.local_uri,
        [{ rotate: angle }],
        { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
      );
      
      await FileSystem.copyAsync({ from: manipResult.uri, to: photo.local_uri });
      setImageRefreshKey(Date.now()); // Forces UI to update cache for THIS photo
    } catch (e) {
      Alert.alert("Error", "Could not rotate photo.");
    }
  };

  const CAMERA_HEIGHT = aspectRatio === '4:3' ? SCREEN_WIDTH * (4 / 3) : SCREEN_WIDTH * (16 / 9);
  const isLandscapeMode = deviceOrientation === 90 || deviceOrientation === -90;
  const overlayContainerWidth = isLandscapeMode ? CAMERA_HEIGHT : SCREEN_WIDTH;
  const overlayContainerHeight = isLandscapeMode ? SCREEN_WIDTH : CAMERA_HEIGHT;
  const displayAspectRatio = aspectRatio === '4:3' ? (isLandscapeMode ? '4:3' : '3:4') : (isLandscapeMode ? '16:9' : '9:16');

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      
      {/* 
        CRITICAL FIX: Hidden ViewShot placed safely in root tree outside Camera Modal.
        Never unmounts prematurely. Captures high-res.
      */}
      {captureQueue.length > 0 && (
        <View style={{ position: 'absolute', top: 0, left: 0, zIndex: -100, opacity: 0.01 }} pointerEvents="none" collapsable={false}>
          {(() => {
             const item = captureQueue[0];
             const isLandscape = item.orientation === 90 || item.orientation === -90;
             const is43 = item.aspectRatio === '4:3';
             
             const shotW = isLandscape ? (is43 ? 1440 : 1920) : 1080;
             const shotH = isLandscape ? 1080 : (is43 ? 1440 : 1920);
             const scaleRatio = shotW / Math.min(SCREEN_WIDTH, SCREEN_HEIGHT);
             
             return (
                <ViewShot ref={viewShotRef} options={{ format: 'jpg', quality: 0.9 }} style={{ width: shotW, height: shotH, backgroundColor: '#000' }} collapsable={false}>
                  {/* Wait for image to load before triggering capture */}
                  <Image source={{ uri: item.uri }} style={{ width: '100%', height: '100%', resizeMode: 'cover' }} onLoad={() => setCaptureTrigger(Date.now())} collapsable={false} />
                  
                  <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center' }} collapsable={false}>
                     {/* isLive=false freezes the time for the saved photo */}
                     <GPSCameraOverlay geoData={item.geoData} sizeRatio={scaleRatio} isLandscape={isLandscape} isLive={false} />
                  </View>
                </ViewShot>
             );
          })()}
        </View>
      )}

      <View style={styles.appBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#1E293B" />
        </TouchableOpacity>
        <Text style={styles.appBarTitle}>Beneficiary Details</Text>
        <View style={{ width: 24 }} />
      </View>

      <FlatList
        data={photos}
        numColumns={COLUMN_COUNT}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <BeneficiaryHeader 
            beneficiary={beneficiary} 
            id={id}
            photosCount={photos.length}
            noteContent={noteContent}
            setNoteContent={setNoteContent}
            isEditingNote={isEditingNote}
            setIsEditingNote={setIsEditingNote}
            saveNote={saveNote}
          />
        }
        contentContainerStyle={styles.listContent}
        columnWrapperStyle={{ paddingHorizontal: 15, justifyContent: 'space-between' }}
        renderItem={({ item, index }) => (
          <TouchableOpacity 
            style={styles.imageWrapper} 
            activeOpacity={0.9}
            onPress={() => setViewerIndex(index)}
          >
            <Image source={{ uri: `${item.local_uri}?v=${imageRefreshKey}` }} style={styles.thumbnail} />
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="images-outline" size={50} color="#CBD5E1" />
            <Text style={styles.emptyText}>No geotagged photos taken yet.</Text>
          </View>
        }
      />

      <View style={styles.fabContainer}>
        <TouchableOpacity style={[styles.fab, { backgroundColor: '#F59E0B', marginBottom: 15 }]} onPress={() => setIsEditingNote(true)}>
          <Ionicons name="pencil" size={24} color="#FFF" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.fab} onPress={openCamera}>
          <Ionicons name="camera" size={28} color="#FFF" />
        </TouchableOpacity>
      </View>

      {/* Live Camera View */}
      <Modal visible={showCamera} transparent animationType="slide" onRequestClose={() => setShowCamera(false)}>
         <View style={styles.cameraContainer}>
            <View style={{ flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
               <View style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT, overflow: 'hidden' }}>
                 {(!liveGeoData || liveGeoData.lat === "0.000000") && (
                   <View style={styles.gpsWaitingOverlay}>
                     <ActivityIndicator size="large" color="#FFF" />
                     <Text style={{color:'#FFF', marginTop: 10, fontWeight: 'bold'}}>Waiting for GPS signals...</Text>
                   </View>
                 )}

                 <CameraView ref={setCameraRef} style={{ width: '100%', height: '100%' }} zoom={ZOOM_STEPS[zoomIndex]} facing="back" flash={flashMode === 'auto' ? 'auto' : flashMode === 'on' ? 'on' : 'off'} ratio={aspectRatio} />

                 {liveGeoData && (
                   <View style={{ 
                      position: 'absolute', width: overlayContainerWidth, height: overlayContainerHeight, 
                      top: (CAMERA_HEIGHT - overlayContainerHeight) / 2, left: (SCREEN_WIDTH - overlayContainerWidth) / 2, 
                      justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 0, 
                      transform: [{ rotate: `${-deviceOrientation}deg` }], pointerEvents: 'none' 
                   }}>
                      {/* isLive=true enables the ticking seconds clock on screen */}
                      <GPSCameraOverlay geoData={liveGeoData} sizeRatio={1} isLandscape={isLandscapeMode} isLive={true} />
                   </View>
                 )}
               </View>
            </View>

            <View style={{ position: 'absolute', top: 60, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start', gap: 20, zIndex: 30 }} pointerEvents="box-none">
               <TouchableOpacity onPress={() => setAspectRatio(a => a === '16:9' ? '4:3' : '16:9')} style={styles.cameraTopBtn}>
                 <Ionicons name="expand" size={24} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
                 <Text style={[styles.cameraTopBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>{displayAspectRatio}</Text>
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

               <TouchableOpacity onPress={() => setFlashMode(f => f === 'auto' ? 'off' : f === 'off' ? 'on' : 'auto')} style={styles.cameraTopBtn}>
                 <Ionicons name={flashMode === 'on' ? "flash" : flashMode === 'auto' ? "flash-outline" : "flash-off"} size={24} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
                 <Text style={[styles.cameraTopBtnText, { transform: [{ rotate: `${-deviceOrientation}deg` }] }]}>{flashMode}</Text>
               </TouchableOpacity>
            </View>

            <View style={styles.cameraControlsContainer} pointerEvents="box-none">
               <TouchableOpacity onPress={() => setShowCamera(false)} style={styles.cameraSideBtn}>
                 <Ionicons name="close" size={36} color="#FFF" style={{ transform: [{ rotate: `${-deviceOrientation}deg` }] }} />
               </TouchableOpacity>
               
               <TouchableOpacity onPress={captureLiveMedia} disabled={isCapturing} style={[styles.cameraCaptureBtnOuter, isCapturing && { borderColor: '#94A3B8' }]}>
                 <View style={[styles.cameraCaptureBtnInner, isCapturing && { backgroundColor: '#E2E8F0' }]} />
               </TouchableOpacity>
               
               <View style={{ width: 50 }} />
            </View>
         </View>
      </Modal>

      <Modal visible={viewerIndex !== null} transparent animationType="fade" onRequestClose={() => setViewerIndex(null)}>
        <View style={styles.viewerContainer}>
          <View style={styles.viewerHeader}>
             <TouchableOpacity style={styles.viewerActionBtn} onPress={() => rotatePhoto(photos[viewerIndex!], 'left')}>
               <Ionicons name="arrow-undo" size={26} color="#FFF" />
             </TouchableOpacity>
             <TouchableOpacity style={styles.viewerActionBtn} onPress={() => rotatePhoto(photos[viewerIndex!], 'right')}>
               <Ionicons name="arrow-redo" size={26} color="#FFF" />
             </TouchableOpacity>
             <TouchableOpacity style={styles.viewerActionBtn} onPress={() => deletePhoto(photos[viewerIndex!].id, photos[viewerIndex!].local_uri)}>
               <Ionicons name="trash" size={26} color="#EF4444" />
             </TouchableOpacity>
             <TouchableOpacity style={[styles.viewerActionBtn, { marginLeft: 10 }]} onPress={() => setViewerIndex(null)}>
               <Ionicons name="close" size={32} color="#FFF" />
             </TouchableOpacity>
          </View>
          
          <View style={{ flex: 1, width: '100%', justifyContent: 'center' }}>
            {viewerIndex !== null && viewerIndex > 0 && (
                <TouchableOpacity style={styles.swipeLeftBtn} onPress={() => setViewerIndex(viewerIndex - 1)}>
                    <Ionicons name="chevron-back" size={36} color="#FFF" />
                </TouchableOpacity>
            )}
            
            {viewerIndex !== null && (
               <Image source={{ uri: `${photos[viewerIndex].local_uri}?v=${imageRefreshKey}` }} style={styles.fullscreenImage} resizeMode="contain" />
            )}

            {viewerIndex !== null && viewerIndex < photos.length - 1 && (
                <TouchableOpacity style={styles.swipeRightBtn} onPress={() => setViewerIndex(viewerIndex + 1)}>
                    <Ionicons name="chevron-forward" size={36} color="#FFF" />
                </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const GPSCameraOverlay = ({ geoData, sizeRatio = 1, isLandscape = false, isLive = false }: { geoData: any, sizeRatio?: number, isLandscape?: boolean, isLive?: boolean }) => {
  const [displayTime, setDisplayTime] = useState(geoData.timestamp);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isLive) {
       interval = setInterval(() => setDisplayTime(formatGeoDate(new Date())), 1000);
    } else {
       setDisplayTime(geoData.timestamp);
    }
    return () => { if (interval) clearInterval(interval); }
  }, [isLive, geoData.timestamp]);

  // Fetched at 200x200 to ensure Google Copyright fits, displayed at 100x100
  const mapUrl = GOOGLE_MAPS_API_KEY
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${geoData.lat},${geoData.lon}&zoom=17&size=200x200&scale=2&markers=color:red%7C${geoData.lat},${geoData.lon}&key=${GOOGLE_MAPS_API_KEY}`
    : `https://staticmap.openstreetmap.de/staticmap.php?center=${geoData.lat},${geoData.lon}&zoom=18&size=200x200&maptype=mapnik&markers=${geoData.lat},${geoData.lon},red-pushpin&t=${Date.now()}`;
 
  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch', width: '100%', paddingHorizontal: 15 * sizeRatio, paddingBottom: 15 * sizeRatio }} collapsable={false}>
      {/* Square Map with Rounded Corners */}
      <View style={{ width: 100 * sizeRatio, borderRadius: 8 * sizeRatio, overflow: 'hidden', marginRight: 10 * sizeRatio, backgroundColor: '#E2E8F0', flexShrink: 0, minHeight: 100 * sizeRatio, borderWidth: 1 * sizeRatio, borderColor: '#FFF' }} collapsable={false}>
         {geoData.lat === "0.000000" ? <View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}><Ionicons name="map" size={24 * sizeRatio} color="#94A3B8" /></View> : <Image source={{ uri: mapUrl }} style={{ flex: 1, width: '100%', height: '100%', resizeMode: 'cover' }} collapsable={false} />}
      </View>

      {/* Translucent Text Box with tighter spacing */}
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 8 * sizeRatio, paddingHorizontal: 10 * sizeRatio, paddingVertical: 8 * sizeRatio, justifyContent: 'center', minHeight: 100 * sizeRatio }} collapsable={false}>
         <Text style={{ color: '#FFF', fontSize: 16 * sizeRatio, fontWeight: 'bold', lineHeight: 20 * sizeRatio, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2 }} numberOfLines={2}>{geoData.city}, {geoData.region}, {geoData.country}</Text>
         <Text style={{ color: '#E2E8F0', fontSize: 13 * sizeRatio, lineHeight: 16 * sizeRatio, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2, marginTop: 2 * sizeRatio }} numberOfLines={2}>{geoData.address}</Text>
         <Text style={{ color: '#F8FAFC', fontSize: 12 * sizeRatio, fontWeight: 'bold', lineHeight: 16 * sizeRatio, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2, marginTop: 4 * sizeRatio }}>Lat {geoData.lat}°   Long {geoData.lon}°</Text>
         <Text style={{ color: '#F8FAFC', fontSize: 12 * sizeRatio, lineHeight: 16 * sizeRatio, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2 }}>{displayTime}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  appBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, paddingTop: 60, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  backBtn: { padding: 5, marginLeft: -5 },
  appBarTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  
  listContent: { paddingBottom: 150 },
  headerContainer: { paddingVertical: 15 },
  
  detailsCard: { backgroundColor: '#FFF', borderRadius: 16, padding: 20, marginHorizontal: 15, marginBottom: 20, borderWidth: 1, borderColor: '#E2E8F0', elevation: 2 },
  detailsHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  avatarCircle: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#EFF6FF', justifyContent: 'center', alignItems: 'center' },
  detailsHeaderText: { marginLeft: 15, flex: 1 },
  beneficiaryName: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  beneficiaryCode: { fontSize: 14, color: '#64748B', marginTop: 2, fontWeight: '500' },
  detailsGrid: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderColor: '#F1F5F9', paddingTop: 15 },
  detailItem: { flex: 1, alignItems: 'center' },
  detailLabel: { fontSize: 11, color: '#94A3B8', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 4 },
  detailValue: { fontSize: 14, color: '#334155', fontWeight: 'bold' },

  notesContainer: { marginHorizontal: 15, marginBottom: 25 },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', marginBottom: 10 },
  notesInput: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 15, fontSize: 15, color: '#1E293B' },
  saveNoteBtn: { backgroundColor: '#2563EB', padding: 12, borderRadius: 10, alignItems: 'center', marginTop: 10 },

  imageWrapper: { width: IMAGE_SIZE, height: IMAGE_SIZE, marginBottom: IMAGE_MARGIN * 2, backgroundColor: '#E2E8F0', borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: '#CBD5E1' },
  thumbnail: { width: '100%', height: '100%', resizeMode: 'cover' },
  
  emptyContainer: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, paddingHorizontal: 30 },
  emptyText: { color: '#475569', marginTop: 15, fontSize: 16, fontWeight: 'bold' },

  fabContainer: { position: 'absolute', bottom: 30, right: 20, alignItems: 'center' },
  fab: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#2563EB', justifyContent: 'center', alignItems: 'center', elevation: 6 },
  
  cameraContainer: { flex: 1, backgroundColor: '#000' },
  cameraTopBtn: { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, alignItems: 'center', justifyContent: 'center', minWidth: 60 },
  cameraTopBtnText: { color: '#FFF', fontSize: 12, fontWeight: 'bold', marginTop: 4 },
  zoomControls: { position: 'absolute', top: 65, flexDirection: 'row', alignItems: 'center', gap: 15 },
  zoomBtnIndividual: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  zoomBtnText: { color: '#FFF', fontSize: 24, fontWeight: 'bold' },
  cameraControlsContainer: { position: 'absolute', bottom: 40, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingHorizontal: 30, zIndex: 50 },
  cameraSideBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  cameraCaptureBtnOuter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  cameraCaptureBtnInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#FFF' },
  gpsWaitingOverlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  
  viewerContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  viewerHeader: { position: 'absolute', top: 40, right: 20, zIndex: 10, flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)', padding: 10, borderRadius: 20 },
  viewerActionBtn: { padding: 5, marginHorizontal: 5 },
  fullscreenImage: { width: '100%', height: '100%' },
  swipeLeftBtn: { position: 'absolute', left: 20, zIndex: 50, padding: 10, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 30 },
  swipeRightBtn: { position: 'absolute', right: 20, zIndex: 50, padding: 10, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 30 },
});