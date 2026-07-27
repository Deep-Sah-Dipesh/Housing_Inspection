import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAppStore } from '../store/appStore';

export default function AuthScreen() {
  const router = useRouter();
  const setAuth = useAppStore((state) => state.setAuth);

  const [loading, setLoading] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const handleAuth = async () => {
    if (!identifier || !password) {
      return Alert.alert("Required", "Please fill in all credentials.");
    }
    
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      setAuth(identifier.toLowerCase().trim(), "Field Agent");
      router.replace('/(tabs)/beneficiaries'); 
    }, 1000);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
      <View style={styles.card}>
        <Ionicons name="home" size={60} color="#2563EB" style={{ alignSelf: 'center', marginBottom: 20 }} />
        <Text style={styles.title}>Housing Inspection</Text>
        
        <TextInput 
          style={styles.input} 
          placeholder="User ID / Email" 
          autoCapitalize="none" 
          value={identifier} 
          onChangeText={setIdentifier} 
        />
        <TextInput 
          style={styles.input} 
          placeholder="Password" 
          secureTextEntry 
          value={password} 
          onChangeText={setPassword} 
        />

        <TouchableOpacity style={styles.primaryBtn} onPress={handleAuth} disabled={loading}>
          {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.btnText}>Login</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFF', padding: 30, borderRadius: 20, elevation: 4 },
  title: { fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 30 },
  input: { backgroundColor: '#F1F5F9', padding: 15, borderRadius: 10, marginBottom: 15 },
  primaryBtn: { backgroundColor: '#2563EB', padding: 15, borderRadius: 10, alignItems: 'center' },
  btnText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 }
});