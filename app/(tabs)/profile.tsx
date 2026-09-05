import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/appStore';

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userId, userName, district, city, clearFilters, logout } = useAppStore();

  const appVersion = Constants.expoConfig?.version || 'Unknown Version';

  const handleLogout = () => {
    Alert.alert(
      "Secure Logout",
      "Are you sure you want to log out? You will need your credentials to log back in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Logout",
          style: "destructive",
          onPress: () => {
            logout();
            router.replace('/');
          }
        }
      ]
    );
  };

  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.header}>
        <Text style={styles.title}>Agent Profile</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarInitial}>{userName ? userName.charAt(0).toUpperCase() : 'A'}</Text>
        </View>
        
        <Text style={styles.name}>{userName || 'Field Agent'}</Text>
        <Text style={styles.userId}>{userId}</Text>

        <View style={styles.divider} />

        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={20} color="#EF4444" style={{ marginRight: 8 }} />
          <Text style={styles.logoutText}>Secure Logout</Text>
        </TouchableOpacity>
      </View>

      {/* Persistent Filters Display */}
      <View style={styles.filterSection}>
        <Text style={styles.sectionTitle}>Active Workspace Filters</Text>
        <Text style={styles.sectionSubtitle}>These filters persist across app restarts to keep you focused on your target region.</Text>
        
        <View style={styles.filterBlock}>
          <View style={styles.filterRow}>
            <Ionicons name="map" size={20} color="#64748B" />
            <Text style={styles.filterLabel}>District:</Text>
            <Text style={[styles.filterValue, !district && styles.filterUnset]}>{district || 'None Selected'}</Text>
          </View>
          
          <View style={styles.filterRow}>
            <Ionicons name="business" size={20} color="#64748B" />
            <Text style={styles.filterLabel}>City / ULB:</Text>
            <Text style={[styles.filterValue, !city && styles.filterUnset]}>{city || 'None Selected'}</Text>
          </View>

          {(district || city) && (
            <TouchableOpacity style={styles.resetFiltersBtn} onPress={clearFilters}>
              <Text style={styles.resetFiltersText}>Reset All Filters</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <Text style={styles.footerText}>Housing Inspection App v{appVersion}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { paddingHorizontal: 20, paddingVertical: 15, backgroundColor: '#F8FAFC' },
  title: { fontSize: 26, fontWeight: '900', color: '#1E293B' },
  
  card: { backgroundColor: '#FFF', marginHorizontal: 20, padding: 30, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0', elevation: 2, marginBottom: 20 },
  avatarCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#EFF6FF', justifyContent: 'center', alignItems: 'center', marginBottom: 15 },
  avatarInitial: { fontSize: 32, fontWeight: 'bold', color: '#2563EB' },
  name: { fontSize: 20, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  userId: { fontSize: 14, color: '#64748B', fontWeight: '500' },
  divider: { height: 1, width: '100%', backgroundColor: '#F1F5F9', marginVertical: 25 },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEF2F2', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#FECACA' },
  logoutText: { color: '#EF4444', fontSize: 16, fontWeight: 'bold' },

  filterSection: { marginHorizontal: 20, marginBottom: 20 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  sectionSubtitle: { fontSize: 13, color: '#64748B', marginBottom: 15, lineHeight: 18 },
  filterBlock: { backgroundColor: '#FFF', padding: 20, borderRadius: 16, borderWidth: 1, borderColor: '#E2E8F0', elevation: 1 },
  filterRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  filterLabel: { fontSize: 15, fontWeight: '600', color: '#475569', marginLeft: 10, width: 80 },
  filterValue: { fontSize: 15, fontWeight: 'bold', color: '#1E293B', flex: 1, textAlign: 'right' },
  filterUnset: { color: '#94A3B8', fontStyle: 'italic', fontWeight: 'normal' },
  resetFiltersBtn: { backgroundColor: '#F1F5F9', paddingVertical: 10, borderRadius: 8, alignItems: 'center', marginTop: 5 },
  resetFiltersText: { color: '#64748B', fontWeight: 'bold', fontSize: 14 },

  footerText: { textAlign: 'center', color: '#94A3B8', marginTop: 20, fontSize: 12 }
});