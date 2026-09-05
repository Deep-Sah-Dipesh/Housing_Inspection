import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Modal, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/appStore';

interface Beneficiary {
  code: string;
  name: string;
  district_name: string;
  city_name: string;
  project_name: string;
  inspection_status: string;
  sync_status: string;
  photo_count: number;
}

const SORT_OPTIONS = ['Name A-Z', 'Name Z-A', 'Inspection Pending', 'Recently Inspected'] as const;
type SortMode = typeof SORT_OPTIONS[number];

export default function BeneficiariesScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { district, city, setFilters, clearFilters } = useAppStore();

  const [data, setData] = useState<Beneficiary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const [sortMode, setSortMode] = useState<SortMode>('Name A-Z');
  const [uniqueDistricts, setUniqueDistricts] = useState<string[]>([]);
  const [uniqueCities, setUniqueCities] = useState<string[]>([]);
  const [activeDropdown, setActiveDropdown] = useState<'district' | 'city' | 'sort' | null>(null);

  const [isAddModalVisible, setAddModalVisible] = useState(false);
  const [newProject, setNewProject] = useState({
    code: '', name: '', serial_number: '', father_name: '',
    district_name: '', city_name: '', project_name: '', site_address: ''
  });

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

  const loadBeneficiaries = useCallback(async () => {
    setIsLoading(true);
    try {
      let query = `
        SELECT b.code, b.name, b.district_name, b.city_name, b.project_name, b.inspection_status, b.sync_status,
        (SELECT COUNT(id) FROM photos WHERE beneficiary_code = b.code) as photo_count
        FROM beneficiaries b WHERE 1=1
      `;
      const params: any[] = [];
      if (searchQuery) { query += ` AND (b.name LIKE ? OR b.code LIKE ?)`; params.push(`%${searchQuery}%`, `%${searchQuery}%`); }
      if (district) { query += ` AND b.district_name = ?`; params.push(district); }
      if (city) { query += ` AND b.city_name = ?`; params.push(city); }

      if (sortMode === 'Name A-Z') query += ` ORDER BY b.name ASC`;
      else if (sortMode === 'Name Z-A') query += ` ORDER BY b.name DESC`;
      else if (sortMode === 'Inspection Pending') query += ` ORDER BY CASE WHEN b.inspection_status = 'pending' THEN 0 ELSE 1 END, b.last_updated DESC`;
      else query += ` ORDER BY CASE WHEN photo_count > 0 THEN 0 ELSE 1 END, b.last_updated DESC`;
      
      query += ` LIMIT 100`;
      const results = await db.getAllAsync<Beneficiary>(query, params);
      setData(results);
    } catch (error) {} finally { setIsLoading(false); }
  }, [db, searchQuery, district, city, sortMode]);

  useFocusEffect(
    useCallback(() => {
      loadFilterOptions();
      loadBeneficiaries();
    }, [loadFilterOptions, loadBeneficiaries])
  );

  const handleAddProject = async () => {
    if (!newProject.code || !newProject.name) return Alert.alert("Missing Fields", "Application Number and Name are required.");
    try {
      await db.runAsync(
        `INSERT INTO beneficiaries (code, name, serial_number, father_name, district_name, city_name, project_name, site_address, inspection_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [newProject.code, newProject.name, newProject.serial_number, newProject.father_name, newProject.district_name, newProject.city_name, newProject.project_name, newProject.site_address]
      );
      setAddModalVisible(false);
      setNewProject({ code: '', name: '', serial_number: '', father_name: '', district_name: '', city_name: '', project_name: '', site_address: '' });
      loadBeneficiaries();
    } catch (error: any) { Alert.alert("Database Error", "Project might already exist."); }
  };

  const renderDropdownModal = () => (
    <Modal visible={activeDropdown !== null} transparent animationType="fade">
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
          <TouchableOpacity style={styles.dropdownCancelBtn} onPress={() => setActiveDropdown(null)}><Text style={styles.dropdownCancelText}>Cancel</Text></TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>Projects</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setAddModalVisible(true)}>
            <Ionicons name="add" size={20} color="#FFF" />
            <Text style={styles.addBtnText}>New</Text>
          </TouchableOpacity>
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

      {isLoading ? <ActivityIndicator size="large" color="#2563EB" style={{ marginTop: 50 }} /> : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.code}
          contentContainerStyle={{ padding: 15, paddingBottom: 100 }}
          renderItem={({ item }) => {
            const hasPhotos = item.photo_count > 0;
            return (
              <TouchableOpacity style={[styles.card, hasPhotos && styles.cardWithPhotos]} onPress={() => router.push(`/beneficiary/${item.code}`)}>
                <View style={styles.cardHeaderInfo}>
                  <Text style={styles.itemTitle}>{item.name}</Text>
                </View>
                <View style={styles.cardSubRow}>
                  <View style={{flexDirection: 'row', alignItems: 'center'}}>
                    <Text style={styles.itemCode}>ID: {item.code}</Text>
                    {item.sync_status === 'pending' ? <Ionicons name="cloud-offline" size={18} color="#D97706" style={{ marginLeft: 6 }} /> : <Ionicons name="cloud-done" size={18} color="#059669" style={{ marginLeft: 6 }} />}
                  </View>
                  {hasPhotos && (
                    <View style={styles.photoCountBadge}>
                      <Ionicons name="images" size={12} color="#10B981" style={{ marginRight: 4 }} />
                      <Text style={styles.photoCountText}>{item.photo_count}</Text>
                    </View>
                  )}
                </View>
                <View style={styles.cardFooter}>
                  <Text style={styles.cardDetail}><Ionicons name="location" size={14} color="#64748B" /> {item.city_name || 'N/A'}, {item.district_name || 'N/A'}</Text>
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

      <Modal visible={isAddModalVisible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modalHeader, { paddingTop: insets.top + 15 }]}>
          <Text style={styles.modalTitle}>Add New Project</Text>
          <TouchableOpacity onPress={() => setAddModalVisible(false)}><Ionicons name="close" size={28} color="#1E293B" /></TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.formContainer}>
          <Text style={styles.inputLabel}>Application Number (Code) *</Text>
          <TextInput style={styles.input} value={newProject.code} onChangeText={(text) => setNewProject({...newProject, code: text})} />
          <Text style={styles.inputLabel}>Beneficiary Name *</Text>
          <TextInput style={styles.input} value={newProject.name} onChangeText={(text) => setNewProject({...newProject, name: text})} />
          <Text style={styles.inputLabel}>Serial Number</Text>
          <TextInput style={styles.input} value={newProject.serial_number} onChangeText={(text) => setNewProject({...newProject, serial_number: text})} keyboardType="numeric" />
          <Text style={styles.inputLabel}>Father Name</Text>
          <TextInput style={styles.input} value={newProject.father_name} onChangeText={(text) => setNewProject({...newProject, father_name: text})} />
          <Text style={styles.inputLabel}>District Name</Text>
          <TextInput style={styles.input} value={newProject.district_name} onChangeText={(text) => setNewProject({...newProject, district_name: text})} />
          <Text style={styles.inputLabel}>City Name</Text>
          <TextInput style={styles.input} value={newProject.city_name} onChangeText={(text) => setNewProject({...newProject, city_name: text})} />
          <Text style={styles.inputLabel}>Project Name</Text>
          <TextInput style={styles.input} value={newProject.project_name} onChangeText={(text) => setNewProject({...newProject, project_name: text})} />
          <Text style={styles.inputLabel}>Site Address</Text>
          <TextInput style={styles.input} value={newProject.site_address} onChangeText={(text) => setNewProject({...newProject, site_address: text})} multiline />

          <TouchableOpacity style={styles.saveBtn} onPress={handleAddProject}><Text style={styles.saveBtnText}>Save Project</Text></TouchableOpacity>
        </ScrollView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { backgroundColor: '#FFF', paddingHorizontal: 20, paddingBottom: 15, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  title: { fontSize: 26, fontWeight: '800', color: '#1E293B' },
  addBtn: { flexDirection: 'row', backgroundColor: '#2563EB', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  addBtnText: { color: '#FFF', fontWeight: 'bold', marginLeft: 4 },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 15, paddingVertical: 10, marginBottom: 10 },
  searchInput: { flex: 1, marginLeft: 10, marginRight: 5, fontSize: 16, color: '#1E293B' },
  filterBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  filterBtn: { flex: 1, flexDirection: 'row', backgroundColor: '#F1F5F9', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#E2E8F0' },
  filterBtnText: { fontSize: 12, color: '#334155', fontWeight: 'bold' },
  clearBtn: { padding: 2 },
  card: { backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: '#E2E8F0', elevation: 2 },
  cardWithPhotos: { borderColor: '#10B981', backgroundColor: '#F0FDF4' },
  cardHeaderInfo: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  itemTitle: { fontSize: 17, fontWeight: '700', color: '#1E293B', flex: 1, marginRight: 10 },
  cardSubRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  itemCode: { fontSize: 13, color: '#64748B', fontWeight: '500' },
  photoCountBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#D1FAE5', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  photoCountText: { fontSize: 12, fontWeight: 'bold', color: '#065F46' },
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
  dropdownCancelText: { color: '#EF4444', fontWeight: 'bold', fontSize: 15 }
});