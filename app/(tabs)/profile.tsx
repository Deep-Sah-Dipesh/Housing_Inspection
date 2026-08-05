import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useAppStore } from '../../store/appStore';

export default function ProfileScreen() {
  const router = useRouter();
  const { userId, userName, logout } = useAppStore();

  // Dynamically pull version from app.config.js
  const appVersion = Constants.expoConfig?.version || 'Unknown Version';

  const handleLogout = () => {
    Alert.alert(
      "Secure Logout",
      "Are you sure you want to log out? You will need your password to log back in.",
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
    <View style={styles.container}>
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

      <Text style={styles.footerText}>Housing Inspection App v{appVersion}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  header: { padding: 20, paddingTop: 60, backgroundColor: '#FFF', borderBottomWidth: 1, borderColor: '#E2E8F0', marginBottom: 20 },
  title: { fontSize: 24, fontWeight: '900', color: '#1E293B' },
  card: { backgroundColor: '#FFF', marginHorizontal: 20, padding: 30, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: '#E2E8F0', elevation: 2 },
  avatarCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#EFF6FF', justifyContent: 'center', alignItems: 'center', marginBottom: 15 },
  avatarInitial: { fontSize: 32, fontWeight: 'bold', color: '#2563EB' },
  name: { fontSize: 20, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  userId: { fontSize: 14, color: '#64748B', fontWeight: '500' },
  divider: { height: 1, width: '100%', backgroundColor: '#F1F5F9', marginVertical: 25 },
  logoutBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FEF2F2', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#FECACA' },
  logoutText: { color: '#EF4444', fontSize: 16, fontWeight: 'bold' },
  footerText: { textAlign: 'center', color: '#94A3B8', marginTop: 30, fontSize: 12 }
});