import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useAppStore } from '../../store/appStore';

export default function ProfileScreen() {
  const router = useRouter();
  const logout = useAppStore((state) => state.logout);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Agent Profile</Text>
      <TouchableOpacity style={styles.btn} onPress={() => { logout(); router.replace('/'); }}>
        <Text style={{color: '#FFF'}}>Logout</Text>
      </TouchableOpacity>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, justifyContent: 'center', alignItems: 'center' }, title: { fontSize: 20, marginBottom: 20 }, btn: { backgroundColor: 'red', padding: 15, borderRadius: 10 } });