import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Modal, Alert, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSQLiteContext } from 'expo-sqlite';
import { useFocusEffect, useRouter } from 'expo-router';

export default function BeneficiariesScreen() {
  const router = useRouter();
  const db = useSQLiteContext();
  const [search, setSearch] = useState('');
  const [beneficiaries, setBeneficiaries] = useState<any[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  
  const [sortBy, setSortBy] = useState<'Date' | 'Name' | 'Code'>('Date');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newMobile, setNewMobile] = useState('');
  const [newAadhar, setNewAadhar] = useState('');
  const [newBank, setNewBank] = useState('');
  const [newAccount, setNewAccount] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newSerial, setNewSerial] = useState('');

  useFocusEffect(
    useCallback(() => { loadLocalBeneficiaries(); }, [])
  );

  const loadLocalBeneficiaries = async () => {
    try {
      const result = await db.getAllAsync(`SELECT * FROM beneficiaries`);
      setBeneficiaries(result || []);
    } catch (e) { console.error(e); }
  };

  const handleManualEntry = async () => {
    if (!newCode.trim()) return Alert.alert("Required", "Beneficiary Code is mandatory.");
    try {
      await db.runAsync(
        `INSERT INTO beneficiaries (code, name, mobile_number, aadhar_number, bank_name, account_number, amount, serial_number, sync_status, last_updated) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
        [newCode.trim(), newName.trim(), newMobile.trim(), newAadhar.trim(), newBank.trim(), newAccount.trim(), newAmount.trim(), newSerial.trim()]
      );
      
      // Reset form
      setNewCode(''); setNewName(''); setNewMobile(''); setNewAadhar('');
      setNewBank(''); setNewAccount(''); setNewAmount(''); setNewSerial('');
      
      setShowAddModal(false);
      loadLocalBeneficiaries();
    } catch (error) {
      Alert.alert("Error", "Failed to save locally. This code might already exist.");
    }
  };

  const filteredAndSortedData = beneficiaries
    .filter(b => b.code.toLowerCase().includes(search.toLowerCase()) || (b.name && b.name.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => {
      if (sortBy === 'Name') return sortOrder === 'asc' ? String(a.name || '').localeCompare(String(b.name || '')) : String(b.name || '').localeCompare(String(a.name || ''));
      if (sortBy === 'Code') return sortOrder === 'asc' ? String(a.code || '').localeCompare(String(b.code || '')) : String(b.code || '').localeCompare(String(a.code || ''));
      // Default Date
      const timeA = new Date(a.last_updated).getTime();
      const timeB = new Date(b.last_updated).getTime();
      return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });

  return (
    <View style={styles.container}>
      {}
      <View style={styles.header}>
        <Text style={styles.title}>Home Workspace</Text>
      </View>
      
      <View style={styles.searchSection}>
        <TextInput style={styles.searchInput} placeholder="Search Code or Name..." value={search} onChangeText={setSearch} />
        
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sortToolbar}>
          <TouchableOpacity style={styles.sortBtn} onPress={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}>
            <Ionicons name={sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'} size={18} color="#2563EB" />
          </TouchableOpacity>
          {['Date', 'Name', 'Code'].map(s => (
            <TouchableOpacity key={s} style={[styles.sortBtn, sortBy === s && styles.sortBtnActive]} onPress={() => setSortBy(s as any)}>
              <Text style={[styles.sortBtnText, sortBy === s && styles.sortBtnTextActive]}>{s}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
      
      <FlatList 
        data={filteredAndSortedData}
        keyExtractor={(item) => item.code}
        contentContainerStyle={{ padding: 15, paddingBottom: 100 }}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => router.push(`/beneficiary/${encodeURIComponent(item.code)}`)}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}}>
               <Text style={styles.cardCode}>{item.code}</Text>
               <Ionicons name={item.sync_status === 'synced' ? "cloud-done" : "cloud-offline"} size={20} color={item.sync_status === 'synced' ? "#10B981" : "#F59E0B"} />
            </View>
            {item.name ? <Text style={styles.cardName}>{item.name}</Text> : null}
            {item.mobile_number ? <Text style={styles.cardDetail}><Ionicons name="call" size={12}/> {item.mobile_number}</Text> : null}
          </TouchableOpacity>
        )}
      />

      <TouchableOpacity style={styles.fab} onPress={() => setShowAddModal(true)}>
        <Ionicons name="add" size={30} color="#FFF" />
      </TouchableOpacity>

      {}
      <Modal visible={showAddModal} transparent animationType="slide">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
               <Text style={styles.modalTitle}>Add Beneficiary</Text>
               <TouchableOpacity onPress={() => setShowAddModal(false)} style={styles.closeBtn}>
                 <Ionicons name="close" size={24} color="#64748B" />
               </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ padding: 25 }}>
              <TextInput style={styles.input} placeholder="Beneficiary Code (Required) *" value={newCode} onChangeText={setNewCode} />
              <TextInput style={styles.input} placeholder="Full Name (Optional)" value={newName} onChangeText={setNewName} />
              
              <View style={styles.rowInputs}>
                <TextInput style={[styles.input, {flex: 1, marginRight: 10}]} placeholder="Mobile No." value={newMobile} onChangeText={setNewMobile} keyboardType="phone-pad" />
                <TextInput style={[styles.input, {flex: 1}]} placeholder="Aadhar No." value={newAadhar} onChangeText={setNewAadhar} keyboardType="numeric" />
              </View>
              
              <TextInput style={styles.input} placeholder="Bank Name" value={newBank} onChangeText={setNewBank} />
              
              <View style={styles.rowInputs}>
                <TextInput style={[styles.input, {flex: 1, marginRight: 10}]} placeholder="Account No." value={newAccount} onChangeText={setNewAccount} keyboardType="numeric" />
                <TextInput style={[styles.input, {flex: 1}]} placeholder="Amount (₹)" value={newAmount} onChangeText={setNewAmount} keyboardType="numeric" />
              </View>

              <TextInput style={styles.input} placeholder="Serial Number" value={newSerial} onChangeText={setNewSerial} keyboardType="numeric" />

              <TouchableOpacity style={styles.primaryBtn} onPress={handleManualEntry}>
                <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 16 }}>Save Offline Record</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#1E293B' },
  searchSection: { backgroundColor: '#FFF', paddingBottom: 10, borderBottomWidth: 1, borderColor: '#E2E8F0' },
  searchInput: { backgroundColor: '#F1F5F9', marginHorizontal: 15, marginTop: 15, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', fontSize: 15 },
  sortToolbar: { flexDirection: 'row', paddingHorizontal: 15, marginTop: 10 },
  sortBtn: { paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20, backgroundColor: '#F1F5F9', marginRight: 10, borderWidth: 1, borderColor: '#E2E8F0', justifyContent: 'center' },
  sortBtnActive: { backgroundColor: '#EFF6FF', borderColor: '#2563EB' },
  sortBtnText: { color: '#64748B', fontWeight: 'bold', fontSize: 13 },
  sortBtnTextActive: { color: '#2563EB' },
  card: { backgroundColor: '#FFF', padding: 20, borderRadius: 12, marginBottom: 12, elevation: 1, borderWidth: 1, borderColor: '#E2E8F0' },
  cardCode: { fontSize: 18, fontWeight: 'bold', color: '#1E293B' },
  cardName: { fontSize: 15, color: '#475569', marginTop: 4 },
  cardDetail: { fontSize: 13, color: '#64748B', marginTop: 4 },
  fab: { position: 'absolute', bottom: 25, right: 20, width: 64, height: 64, borderRadius: 32, backgroundColor: '#2563EB', justifyContent: 'center', alignItems: 'center', elevation: 5 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#1E293B' },
  closeBtn: { padding: 5, backgroundColor: '#F1F5F9', borderRadius: 20 },
  rowInputs: { flexDirection: 'row', justifyContent: 'space-between' },
  input: { backgroundColor: '#F8FAFC', padding: 15, borderRadius: 12, marginBottom: 15, borderWidth: 1, borderColor: '#E2E8F0', fontSize: 15 },
  primaryBtn: { backgroundColor: '#2563EB', padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 10, marginBottom: 20 }
});