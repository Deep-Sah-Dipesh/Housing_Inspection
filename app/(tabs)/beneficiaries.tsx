import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Modal, ScrollView, Alert, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/appStore';
import { deriveAuthorId, isOwnedByCurrentUser, resolveAuthorName } from '../../utils/authorHelpers';

interface Beneficiary {
  code: string;
  name: string;
  district_name: string;
  city_name: string;
  project_name: string;
  inspection_status: string;
  sync_status: string;
  photo_count: number;
  report_count: number;
  is_custom?: number;
  author_id?: string | null;
  author_name?: string | null;
  latest_report_author_id?: string | null;
  latest_report_author_name?: string | null;
}

const SORT_OPTIONS = ['Name A-Z', 'Name Z-A', 'Inspection Pending', 'Recently Inspected', 'Recently Added'] as const;
type SortMode = typeof SORT_OPTIONS[number];

const getShortSortName = (sort: SortMode) => {
  if (sort === 'Recently Inspected') return 'Recent';
  if (sort === 'Recently Added') return 'Added';
  if (sort === 'Inspection Pending') return 'Pending';
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

export default function BeneficiariesScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    userId,
    authorId,
    userName,
    officialName,
    district,
    city,
    setFilters,
    clearFilters,
    seedSyncVersion,
  } = useAppStore();

  const ownershipCtx = {
    currentAuthorId: authorId,
    currentUserId: userId,
    currentOfficialName: officialName,
    currentUserName: userName,
  };

  const [data, setData] = useState<Beneficiary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasLoadedOnceRef = useRef(false);

  const [sortMode, setSortMode] = useState<SortMode>('Name A-Z');
  const [pageLimit, setPageLimit] = useState(100);
  const [uniqueDistricts, setUniqueDistricts] = useState<string[]>([]);
  const [uniqueCities, setUniqueCities] = useState<string[]>([]);
  const [activeDropdown, setActiveDropdown] = useState<'district' | 'city' | 'sort' | null>(null);

  const [isAddModalVisible, setAddModalVisible] = useState(false);
  const [newProject, setNewProject] = useState({
    code: '', name: '', serial_number: '', father_name: '',
    district_name: '', city_name: '', project_name: '', site_address: ''
  });
  const [addDistrictMode, setAddDistrictMode] = useState<'select' | 'custom'>('select');
  const [addCityMode, setAddCityMode] = useState<'select' | 'custom'>('select');
  const [addDropdown, setAddDropdown] = useState<'district' | 'city' | null>(null);
  const [addAvailableCities, setAddAvailableCities] = useState<string[]>([]);

  useEffect(() => {
    setPageLimit(100);
  }, [searchQuery, district, city, sortMode]);

  useEffect(() => {
    const selectedDistrict = newProject.district_name.trim();
    if (!isAddModalVisible || !selectedDistrict) {
      setAddAvailableCities([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await db.getAllAsync<{ city_name: string }>(
          `SELECT DISTINCT city_name FROM beneficiaries WHERE LOWER(TRIM(district_name)) = LOWER(TRIM(?)) AND city_name IS NOT NULL AND TRIM(city_name) != '' ORDER BY city_name ASC`,
          [selectedDistrict]
        );
        if (!cancelled) {
          setAddAvailableCities(rows.map(r => r.city_name));
        }
      } catch {
        if (!cancelled) setAddAvailableCities([]);
      }
    })();
    return () => { cancelled = true; };
  }, [db, isAddModalVisible, newProject.district_name]);

  const resetAddModal = () => {
    setNewProject({
      code: '', name: '', serial_number: '', father_name: '',
      district_name: '', city_name: '', project_name: '', site_address: ''
    });
    setAddDistrictMode('select');
    setAddCityMode('select');
    setAddDropdown(null);
    setAddAvailableCities([]);
  };

  const loadFilterOptions = useCallback(async () => {
    try {
      const dists = await db.getAllAsync<{district_name: string}>(`SELECT DISTINCT district_name FROM beneficiaries WHERE district_name IS NOT NULL AND TRIM(district_name) != '' ORDER BY district_name ASC`);
      setUniqueDistricts(dists.map(d => d.district_name));
      let cityQuery = `SELECT DISTINCT city_name FROM beneficiaries WHERE city_name IS NOT NULL AND TRIM(city_name) != ''`;
      const cityParams: string[] = [];
      if (district) { cityQuery += ` AND LOWER(TRIM(district_name)) = LOWER(TRIM(?))`; cityParams.push(district); }
      cityQuery += ` ORDER BY city_name ASC`;
      const cits = await db.getAllAsync<{city_name: string}>(cityQuery, cityParams);
      setUniqueCities(cits.map(c => c.city_name));
    } catch {}
  }, [db, district]);

  const loadBeneficiaries = useCallback(async () => {
    if (!hasLoadedOnceRef.current) {
      setIsLoading(true);
    }
    try {
      let query = `
        SELECT b.code, b.name, b.district_name, b.city_name, b.project_name, b.inspection_status, b.sync_status,
               COALESCE(b.is_custom, 0) as is_custom,
               b.author_id, b.author_name,
               (SELECT COUNT(id) FROM photos WHERE beneficiary_code = b.code) as photo_count,
               (SELECT COUNT(id) FROM reports WHERE beneficiary_code = b.code) as report_count,
               (SELECT author_id FROM reports WHERE beneficiary_code = b.code ORDER BY created_at DESC LIMIT 1) as latest_report_author_id,
               (SELECT author_name FROM reports WHERE beneficiary_code = b.code ORDER BY created_at DESC LIMIT 1) as latest_report_author_name
        FROM beneficiaries b WHERE 1=1
      `;
      const params: (string | number)[] = [];
      if (searchQuery) {
        query += ` AND (b.name LIKE ? OR b.code LIKE ? OR b.city_name LIKE ? OR b.district_name LIKE ?)`;
        params.push(`%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`);
      }
      if (district) { query += ` AND LOWER(TRIM(b.district_name)) = LOWER(TRIM(?))`; params.push(district); }
      if (city) { query += ` AND LOWER(TRIM(b.city_name)) = LOWER(TRIM(?))`; params.push(city); }

      if (sortMode === 'Name A-Z') query += ` ORDER BY b.name ASC`;
      else if (sortMode === 'Name Z-A') query += ` ORDER BY b.name DESC`;
      else if (sortMode === 'Inspection Pending') query += ` ORDER BY CASE WHEN b.inspection_status = 'pending' THEN 0 ELSE 1 END, b.last_updated DESC`;
      else if (sortMode === 'Recently Added') query += ` ORDER BY COALESCE(b.is_custom, 0) DESC, b.last_updated DESC, b.rowid DESC`;
      else query += ` ORDER BY CASE WHEN (photo_count > 0 OR report_count > 0) THEN 0 ELSE 1 END, b.last_updated DESC`;
      
      query += ` LIMIT ?`;
      params.push(pageLimit);
      const results = await db.getAllAsync<Beneficiary>(query, params);
      setData(results);
      hasLoadedOnceRef.current = true;
    } catch (error) {
      console.error('Failed to load beneficiaries:', error);
    } finally { setIsLoading(false); }
  }, [db, searchQuery, district, city, sortMode, pageLimit]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await loadFilterOptions();
      await loadBeneficiaries();
    } finally {
      setIsRefreshing(false);
    }
  }, [loadFilterOptions, loadBeneficiaries]);

  useFocusEffect(
    useCallback(() => {
      loadFilterOptions();
      loadBeneficiaries();
    }, [loadFilterOptions, loadBeneficiaries, seedSyncVersion])
  );

  const handleAddProject = async () => {
    const cleanCode = newProject.code.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    const cleanName = newProject.name.trim();
    if (!cleanCode || !cleanName) {
      return Alert.alert("Missing Fields", "Code and Beneficiary Name are required.");
    }

    const cleanSerial = newProject.serial_number.trim();
    const cleanFather = newProject.father_name.trim();
    const cleanDistrict = newProject.district_name.trim();
    const cleanCity = cleanDistrict ? newProject.city_name.trim() : '';
    const cleanProjectName = newProject.project_name.trim();
    const cleanSiteAddress = newProject.site_address.trim();

    const effectiveAuthorId = authorId || deriveAuthorId(userId) || null;
    const effectiveAuthorName = resolveAuthorName(officialName, userName);

    try {
      const existing = await db.getFirstAsync<{ code: string }>(`SELECT code FROM beneficiaries WHERE code = ?`, [cleanCode]);
      if (existing) {
        return Alert.alert("Duplicate Project", "A project with this Code already exists.");
      }

      await db.runAsync(
        `INSERT INTO beneficiaries (
          code, name, serial_number, father_name, district_name, city_name,
          project_name, site_address, inspection_status, sync_status, is_custom,
          author_id, author_name, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 1, ?, ?, CURRENT_TIMESTAMP)`,
        [
          cleanCode, cleanName, cleanSerial, cleanFather, cleanDistrict, cleanCity,
          cleanProjectName, cleanSiteAddress, effectiveAuthorId, effectiveAuthorName,
        ]
      );

      // Clear active filters if they would hide the newly added custom project
      if ((district && district !== cleanDistrict) || (city && city !== cleanCity)) {
        clearFilters();
      }
      setSearchQuery('');
      setSortMode('Recently Added');
      setAddModalVisible(false);
      resetAddModal();
      await loadFilterOptions();
      await loadBeneficiaries();
    } catch {
      Alert.alert("Database Error", "Could not save project. Please try again.");
    }
  };

  const renderDropdownModal = () => (
    <Modal visible={activeDropdown !== null} transparent animationType="fade" onRequestClose={() => setActiveDropdown(null)}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setActiveDropdown(null)}>
        <View style={styles.dropdownCard}>
          <Text style={styles.dropdownTitle}>{activeDropdown === 'district' ? 'Select District' : activeDropdown === 'city' ? 'Select City' : 'Sort By'}</Text>
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
                  <Text style={[styles.dropdownOptionText, isSelected && styles.dropdownOptionSelectedText]}>{opt === 'All Districts' ? 'All Districts' : toTitleCase(opt)}</Text>
                </TouchableOpacity>
              );
            })}
            {activeDropdown === 'city' && ['All Cities', ...uniqueCities].map((opt) => {
              const isSelected = city === opt || (!city && opt === 'All Cities');
              return (
                <TouchableOpacity key={opt} style={styles.dropdownOption} onPress={() => { setFilters(district, opt === 'All Cities' ? null : opt); setActiveDropdown(null); }}>
                  <Text style={[styles.dropdownOptionText, isSelected && styles.dropdownOptionSelectedText]}>{opt === 'All Cities' ? 'All Cities' : toTitleCase(opt)}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TouchableOpacity style={styles.dropdownCancelBtn} onPress={() => setActiveDropdown(null)}><Text style={styles.dropdownCancelText}>Cancel</Text></TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>All Projects</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setAddModalVisible(true)}>
            <Ionicons name="add" size={20} color="#FFF" />
            <Text style={styles.addBtnText}>Add</Text>
          </TouchableOpacity>
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
            <TouchableOpacity style={[styles.filterBtn, district && styles.filterBtnActive]} onPress={() => setActiveDropdown('district')}>
              <Text style={[styles.filterBtnText, district && styles.filterBtnTextActive]} numberOfLines={1}>{district ? toTitleCase(district) : 'District'}</Text>
              <Ionicons name="chevron-down" size={14} color={district ? "#2563EB" : "#64748B"} />
            </TouchableOpacity>
            
            <TouchableOpacity style={[styles.filterBtn, city && styles.filterBtnActive]} onPress={() => setActiveDropdown('city')}>
              <Text style={[styles.filterBtnText, city && styles.filterBtnTextActive]} numberOfLines={1}>{city ? getFirstWord(toTitleCase(city)) : 'City'}</Text>
              <Ionicons name="chevron-down" size={14} color={city ? "#2563EB" : "#64748B"} />
            </TouchableOpacity>
            
            <TouchableOpacity style={[styles.filterBtn, sortMode !== 'Name A-Z' && styles.filterBtnActive]} onPress={() => setActiveDropdown('sort')}>
              <Ionicons name="swap-vertical" size={14} color={sortMode !== 'Name A-Z' ? "#2563EB" : "#64748B"} style={{marginRight: 4}} />
              <Text style={[styles.filterBtnText, sortMode !== 'Name A-Z' && styles.filterBtnTextActive]} numberOfLines={1}>{getShortSortName(sortMode)}</Text>
            </TouchableOpacity>
          </ScrollView>

          {(district || city || sortMode !== 'Name A-Z') && (
            <View style={{ paddingLeft: 8 }}>
              <TouchableOpacity onPress={() => { clearFilters(); setSortMode('Name A-Z'); setSearchQuery(''); }} style={styles.fixedClearBtn}>
                <Ionicons name="close-circle" size={26} color="#EF4444" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {isLoading ? <ActivityIndicator size="large" color="#2563EB" style={{ marginTop: 50 }} /> : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.code}
          contentContainerStyle={{ flexGrow: 1, padding: 15, paddingBottom: 100 }}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} colors={['#2563EB']} tintColor="#2563EB" />
          }
          onEndReached={() => {
            if (!isLoading && data.length >= pageLimit) {
              setPageLimit(prev => prev + 100);
            }
          }}
          onEndReachedThreshold={0.4}
          renderItem={({ item }) => {
            const hasInspection = item.photo_count > 0 || item.report_count > 0;
            const isOwnedByYou = isOwnedByCurrentUser(
              {
                authorId: item.latest_report_author_id ?? item.author_id,
                authorName: item.latest_report_author_name ?? item.author_name,
              },
              ownershipCtx
            );
            const isLocalInspected = hasInspection && isOwnedByYou;
            const isImportedInspected = hasInspection && !isOwnedByYou;

            const locationLabel = [item.city_name, item.district_name]
              .filter((v): v is string => Boolean(v && v.trim()))
              .map(toTitleCase)
              .join(', ') || 'No location specified';

            return (
              <TouchableOpacity
                style={[
                  styles.card,
                  isLocalInspected && styles.cardLocalOwned,
                  isImportedInspected && styles.cardImported,
                ]}
                onPress={() => router.push(`/beneficiary/${encodeURIComponent(item.code)}`)}
              >
                <View style={styles.cardHeaderInfo}>
                  <Text style={styles.itemTitle} numberOfLines={2}>{toTitleCase(item.name)}</Text>
                  {item.is_custom === 1 && (
                    <View style={styles.customBadge}>
                      <Text style={styles.customBadgeText}>Custom</Text>
                    </View>
                  )}
                </View>

                <View style={styles.cardSubRow}>
                  <Text style={styles.itemCode}>ID: {item.code}</Text>
                  
                  <View style={{flexDirection: 'row', alignItems: 'center'}}>
                    {item.photo_count > 0 && (
                      <View style={[styles.photoCountBadge, isImportedInspected && styles.photoCountBadgeImported]}>
                        <Text style={[styles.photoCountText, isImportedInspected && styles.photoCountTextImported]}>{item.photo_count}</Text>
                        <Ionicons name="images" size={12} color={isImportedInspected ? '#B45309' : '#10B981'} style={{ marginLeft: 4 }} />
                      </View>
                    )}
                    {item.sync_status === 'pending' ? <Ionicons name="cloud-offline" size={18} color="#D97706" style={{ marginLeft: 8 }} /> : <Ionicons name="cloud-done" size={18} color="#059669" style={{ marginLeft: 8 }} />}
                  </View>
                </View>
                <View style={styles.cardFooter}>
                  <Text style={[styles.cardDetail, { flex: 1, marginRight: 8 }]} numberOfLines={1}>
                    <Ionicons name="location" size={14} color="#64748B" /> {locationLabel}
                  </Text>
                  {hasInspection && (
                    <View style={[styles.ownerBadge, isLocalInspected ? styles.ownerBadgeYou : styles.ownerBadgeImported]}>
                      <Text style={[styles.ownerBadgeText, isLocalInspected ? styles.ownerBadgeTextYou : styles.ownerBadgeTextImported]}>
                        {isLocalInspected ? 'You' : 'Imported'}
                      </Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="folder-open-outline" size={50} color="#CBD5E1" />
              <Text style={styles.emptyStateText}>No projects found.</Text>
            </View>
          }
        />
      )}

      {renderDropdownModal()}

      <Modal visible={isAddModalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { setAddModalVisible(false); resetAddModal(); }}>
        <View style={[styles.modalHeader, { paddingTop: insets.top + 15 }]}>
          <Text style={styles.modalTitle}>Add New Project</Text>
          <TouchableOpacity onPress={() => { setAddModalVisible(false); resetAddModal(); }}><Ionicons name="close" size={28} color="#1E293B" /></TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.formContainer} keyboardShouldPersistTaps="handled">
          <Text style={styles.inputLabel}>Code *</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. GJ034380125146007239"
            placeholderTextColor="#94A3B8"
            autoCapitalize="characters"
            autoCorrect={false}
            value={newProject.code}
            onChangeText={(text) =>
              setNewProject({ ...newProject, code: text.toUpperCase().replace(/[^A-Z0-9]/g, '') })
            }
          />
          <Text style={styles.inputLabel}>Beneficiary Name *</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter beneficiary name"
            placeholderTextColor="#94A3B8"
            autoCapitalize="sentences"
            value={newProject.name}
            onChangeText={(text) => setNewProject({ ...newProject, name: text })}
          />
          <Text style={styles.inputLabel}>Serial Number</Text>
          <TextInput style={styles.input} placeholder="Optional" placeholderTextColor="#94A3B8" value={newProject.serial_number} onChangeText={(text) => setNewProject({...newProject, serial_number: text})} keyboardType="numeric" />
          <Text style={styles.inputLabel}>Father Name</Text>
          <TextInput style={styles.input} placeholder="Optional" placeholderTextColor="#94A3B8" value={newProject.father_name} onChangeText={(text) => setNewProject({...newProject, father_name: text})} />

          <Text style={styles.inputLabel}>District Name</Text>
          <View style={styles.selectRow}>
            <TouchableOpacity style={styles.selectTrigger} onPress={() => setAddDropdown('district')}>
              <Text style={[styles.selectTriggerText, !newProject.district_name && addDistrictMode !== 'custom' && styles.selectPlaceholder]}>
                {addDistrictMode === 'custom'
                  ? 'Custom District'
                  : (newProject.district_name ? toTitleCase(newProject.district_name) : 'Select District (Optional)')}
              </Text>
              <Ionicons name="chevron-down" size={18} color="#64748B" />
            </TouchableOpacity>
            {(newProject.district_name.length > 0 || addDistrictMode === 'custom') && (
              <TouchableOpacity
                style={styles.clearSelectionBtn}
                onPress={() => {
                  setAddDistrictMode('select');
                  setAddCityMode('select');
                  setNewProject({ ...newProject, district_name: '', city_name: '' });
                }}
              >
                <Ionicons name="close-circle" size={22} color="#94A3B8" />
              </TouchableOpacity>
            )}
          </View>
          {addDistrictMode === 'custom' && (
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              placeholder="Type custom district name..."
              placeholderTextColor="#94A3B8"
              value={newProject.district_name}
              onChangeText={(text) => setNewProject({ ...newProject, district_name: text, city_name: '' })}
            />
          )}

          <Text style={styles.inputLabel}>City Name</Text>
          <View style={styles.selectRow}>
            <TouchableOpacity
              style={[styles.selectTrigger, !newProject.district_name.trim() && styles.selectTriggerDisabled]}
              onPress={() => {
                if (!newProject.district_name.trim()) {
                  Alert.alert("Select District First", "Please select or enter a District before choosing a City.");
                  return;
                }
                setAddDropdown('city');
              }}
            >
              <Text style={[styles.selectTriggerText, (!newProject.district_name.trim() || (!newProject.city_name && addCityMode !== 'custom')) && styles.selectPlaceholder]}>
                {!newProject.district_name.trim()
                  ? 'Select a District first'
                  : addCityMode === 'custom'
                    ? 'Custom City'
                    : (newProject.city_name ? toTitleCase(newProject.city_name) : 'Select City (Optional)')}
              </Text>
              <Ionicons name="chevron-down" size={18} color="#64748B" />
            </TouchableOpacity>
            {(newProject.city_name.length > 0 || addCityMode === 'custom') && (
              <TouchableOpacity
                style={styles.clearSelectionBtn}
                onPress={() => {
                  setAddCityMode('select');
                  setNewProject({ ...newProject, city_name: '' });
                }}
              >
                <Ionicons name="close-circle" size={22} color="#94A3B8" />
              </TouchableOpacity>
            )}
          </View>
          {addCityMode === 'custom' && newProject.district_name.trim().length > 0 && (
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              placeholder="Type custom city name..."
              placeholderTextColor="#94A3B8"
              value={newProject.city_name}
              onChangeText={(text) => setNewProject({ ...newProject, city_name: text })}
            />
          )}

          <Text style={styles.inputLabel}>Project Name</Text>
          <TextInput style={styles.input} placeholder="Optional" placeholderTextColor="#94A3B8" value={newProject.project_name} onChangeText={(text) => setNewProject({...newProject, project_name: text})} />
          <Text style={styles.inputLabel}>Site Address</Text>
          <TextInput style={styles.input} placeholder="Optional" placeholderTextColor="#94A3B8" value={newProject.site_address} onChangeText={(text) => setNewProject({...newProject, site_address: text})} multiline />

          <TouchableOpacity style={styles.saveBtn} onPress={handleAddProject}><Text style={styles.saveBtnText}>Save Project</Text></TouchableOpacity>
        </ScrollView>

        {addDropdown !== null && (
          <TouchableOpacity style={styles.inModalOverlay} activeOpacity={1} onPress={() => setAddDropdown(null)}>
            <View style={styles.dropdownCard} onStartShouldSetResponder={() => true}>
              <Text style={styles.dropdownTitle}>
                {addDropdown === 'district' ? 'Select District' : `Select City (${toTitleCase(newProject.district_name)})`}
              </Text>
              <ScrollView style={{ maxHeight: 320 }}>
                <TouchableOpacity
                  style={[styles.dropdownOption, styles.customDropdownOption]}
                  onPress={() => {
                    if (addDropdown === 'district') {
                      setAddDistrictMode('custom');
                      setAddCityMode('select');
                      setNewProject({ ...newProject, district_name: '', city_name: '' });
                    } else {
                      setAddCityMode('custom');
                      setNewProject({ ...newProject, city_name: '' });
                    }
                    setAddDropdown(null);
                  }}
                >
                  <Text style={styles.customDropdownOptionText}>+ Custom (Enter Manually)</Text>
                </TouchableOpacity>

                {addDropdown === 'district' && uniqueDistricts.map((opt) => {
                  const isSelected = addDistrictMode === 'select' && newProject.district_name === opt;
                  return (
                    <TouchableOpacity
                      key={opt}
                      style={styles.dropdownOption}
                      onPress={() => {
                        setAddDistrictMode('select');
                        setAddCityMode('select');
                        setNewProject({ ...newProject, district_name: opt, city_name: '' });
                        setAddDropdown(null);
                      }}
                    >
                      <Text style={[styles.dropdownOptionText, isSelected && styles.dropdownOptionSelectedText]}>{toTitleCase(opt)}</Text>
                    </TouchableOpacity>
                  );
                })}

                {addDropdown === 'city' && addAvailableCities.map((opt) => {
                  const isSelected = addCityMode === 'select' && newProject.city_name === opt;
                  return (
                    <TouchableOpacity
                      key={opt}
                      style={styles.dropdownOption}
                      onPress={() => {
                        setAddCityMode('select');
                        setNewProject({ ...newProject, city_name: opt });
                        setAddDropdown(null);
                      }}
                    >
                      <Text style={[styles.dropdownOptionText, isSelected && styles.dropdownOptionSelectedText]}>{toTitleCase(opt)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TouchableOpacity style={styles.dropdownCancelBtn} onPress={() => setAddDropdown(null)}>
                <Text style={styles.dropdownCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: '#FFF', paddingHorizontal: 20, paddingBottom: 15, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  title: { fontSize: 26, fontWeight: '800', color: '#1E293B' },
  addBtn: { flexDirection: 'row', backgroundColor: '#2563EB', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  addBtnText: { color: '#FFF', fontWeight: 'bold', marginLeft: 4 },
  searchContainer: { flexDirection: 'row', alignItems: 'center', width: '100%', height: 46, backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 14, marginBottom: 10 },
  searchInput: { flex: 1, minWidth: 0, height: '100%', marginLeft: 10, marginRight: 6, fontSize: 15, color: '#1E293B', paddingVertical: 0 },
  
  filterWrapper: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  filterScrollContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterBtn: { flexDirection: 'row', backgroundColor: '#F1F5F9', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  filterBtnActive: { backgroundColor: '#EFF6FF', borderColor: '#2563EB' },
  filterBtnText: { fontSize: 13, color: '#334155', fontWeight: 'bold', marginRight: 4 },
  filterBtnTextActive: { color: '#2563EB' },
  fixedClearBtn: { padding: 2, backgroundColor: '#FFF', borderRadius: 16 },
  
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', elevation: 2 },
  cardLocalOwned: { borderColor: '#10B981', backgroundColor: '#F0FDF4' },
  cardImported: { borderColor: '#EAB308', backgroundColor: '#FEFCE8' },
  cardHeaderInfo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  itemTitle: { fontSize: 17, fontWeight: '700', color: '#1E293B', flex: 1, marginRight: 10 },
  ownerBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1 },
  ownerBadgeYou: { backgroundColor: '#DCFCE7', borderColor: '#86EFAC' },
  ownerBadgeImported: { backgroundColor: '#FEF3C7', borderColor: '#FDE047' },
  ownerBadgeText: { fontSize: 11, fontWeight: '800' },
  ownerBadgeTextYou: { color: '#166534' },
  ownerBadgeTextImported: { color: '#92400E' },
  cardSubRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  itemCode: { fontSize: 13, color: '#64748B', fontWeight: '500' },
  photoCountBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#D1FAE5', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  photoCountBadgeImported: { backgroundColor: '#FEF3C7' },
  photoCountText: { fontSize: 12, fontWeight: 'bold', color: '#065F46' },
  photoCountTextImported: { color: '#92400E' },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  cardDetail: { fontSize: 13, color: '#475569' },
  emptyState: { alignItems: 'center', marginTop: 80 },
  emptyStateText: { marginTop: 10, color: '#475569', fontSize: 16, fontWeight: 'bold' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 15, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#1E293B' },
  formContainer: { padding: 20, paddingBottom: 60 },
  inputLabel: { fontSize: 14, fontWeight: '600', color: '#475569', marginBottom: 6, marginTop: 15 },
  input: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, padding: 12, fontSize: 16, color: '#1E293B' },
  saveBtn: { backgroundColor: '#10B981', padding: 16, borderRadius: 10, alignItems: 'center', marginTop: 30 },
  saveBtnText: { color: '#FFF', fontSize: 16, fontWeight: 'bold' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  dropdownCard: { backgroundColor: '#FFF', width: '100%', borderRadius: 12, overflow: 'hidden', elevation: 5 },
  dropdownTitle: { fontSize: 16, fontWeight: 'bold', color: '#1E293B', padding: 15, borderBottomWidth: 1, borderColor: '#E2E8F0', backgroundColor: '#F8FAFC', textAlign: 'center' },
  dropdownOption: { justifyContent: 'center', alignItems: 'center', padding: 15, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  dropdownOptionText: { fontSize: 16, color: '#475569', textAlign: 'center', width: '100%' },
  dropdownOptionSelectedText: { color: '#2563EB', fontWeight: 'bold' },
  dropdownCancelBtn: { padding: 15, alignItems: 'center', backgroundColor: '#FEF2F2' },
  dropdownCancelText: { color: '#EF4444', fontWeight: 'bold', fontSize: 15 },
  customBadge: { backgroundColor: '#DBEAFE', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  customBadgeText: { fontSize: 11, fontWeight: '700', color: '#1D4ED8' },
  selectRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectTrigger: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FFF', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 13 },
  selectTriggerDisabled: { backgroundColor: '#F1F5F9', borderColor: '#E2E8F0' },
  selectTriggerText: { fontSize: 16, color: '#1E293B', flex: 1, marginRight: 8 },
  selectPlaceholder: { color: '#94A3B8' },
  clearSelectionBtn: { padding: 4 },
  inModalOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20, zIndex: 50 },
  customDropdownOption: { backgroundColor: '#EFF6FF' },
  customDropdownOptionText: { fontSize: 16, color: '#2563EB', fontWeight: 'bold', textAlign: 'center', width: '100%' }
});