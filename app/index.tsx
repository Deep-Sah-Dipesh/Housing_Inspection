import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAppStore } from '../store/appStore';

export default function AuthScreen() {
  const router = useRouter();
  const setAuth = useAppStore((state) => state.setAuth);
  const userId = useAppStore((state) => state.userId);
  const _hasHydrated = useAppStore((state) => state._hasHydrated);

  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');

  // Wait for the local storage to load, then instantly bypass if logged in
  useEffect(() => {
    if (_hasHydrated && userId) {
      router.replace('/(tabs)/beneficiaries');
    }
  }, [_hasHydrated, userId]);

  const handleAuth = async () => {
    if (!identifier || !password) {
      return Alert.alert("Required", "Please fill in all credentials.");
    }
    
    setLoading(true);

    // Extract name from email if Full Name wasn't provided
    const extractedName = identifier.split('@')[0];
    const finalName = !isLogin && fullName.trim() ? fullName.trim() : extractedName;

    // Simulate Authentication 
    setTimeout(() => {
      setLoading(false);
      setAuth(identifier.toLowerCase().trim(), finalName);
      router.replace('/(tabs)/beneficiaries');
    }, 1500);
  };

  // Show a loading screen while checking device storage to prevent login flashes
  if (!_hasHydrated) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC' }}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={{ marginTop: 10, color: '#64748B', fontWeight: 'bold' }}>Verifying Identity...</Text>
      </View>
    );
  }

  // Double-safety check to hide UI if transitioning
  if (userId) return null;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <Ionicons name="shield-checkmark" size={40} color="#2563EB" />
        </View>

        <Text style={styles.title}>{isLogin ? 'Housing Inspection' : 'Create Account'}</Text>
        <Text style={styles.subtitle}>
          {isLogin ? 'Login to access your local workspace and sync reports.' : 'Register to begin collecting field data.'}
        </Text>

        {!isLogin && (
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Full Name</Text>
            <TextInput 
              style={styles.input} 
              placeholder="e.g. John Doe" 
              placeholderTextColor="#94A3B8" 
              value={fullName} 
              onChangeText={setFullName} 
              autoCapitalize="words"
            />
          </View>
        )}

        <View style={styles.inputGroup}>
          <Text style={styles.label}>User ID / Email</Text>
          <TextInput 
            style={styles.input} 
            placeholder="Enter unique ID or Email" 
            placeholderTextColor="#94A3B8" 
            autoCapitalize="none" 
            autoCorrect={false}
            keyboardType="email-address"
            value={identifier} 
            onChangeText={setIdentifier} 
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>Password</Text>
          <TextInput 
            style={styles.input} 
            placeholder="••••••••" 
            placeholderTextColor="#94A3B8" 
            secureTextEntry 
            value={password} 
            onChangeText={setPassword} 
          />
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={handleAuth} disabled={loading}>
          {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.btnText}>{isLogin ? 'Secure Login' : 'Register Device'}</Text>}
        </TouchableOpacity>

        <View style={styles.switchModeContainer}>
          <Text style={styles.switchModeText}>{isLogin ? 'New agent? ' : 'Already registered? '}</Text>
          <TouchableOpacity onPress={() => setIsLogin(!isLogin)}>
            <Text style={styles.linkText}>{isLogin ? 'Create Account' : 'Back to Login'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC', justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', width: '100%', maxWidth: 400, padding: 30, borderRadius: 24, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 4, borderWidth: 1, borderColor: '#E2E8F0' },
  iconCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#EFF6FF', justifyContent: 'center', alignItems: 'center', alignSelf: 'center', marginBottom: 20 },
  title: { fontSize: 24, fontWeight: '800', color: '#1E293B', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 13, color: '#64748B', textAlign: 'center', marginBottom: 30, lineHeight: 20 },
  inputGroup: { marginBottom: 16, width: '100%' },
  label: { fontSize: 12, fontWeight: '700', color: '#64748B', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 16, paddingVertical: 14, borderRadius: 12, fontSize: 15, color: '#1E293B' },
  primaryBtn: { backgroundColor: '#2563EB', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  btnText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  switchModeContainer: { flexDirection: 'row', justifyContent: 'center', marginTop: 25 },
  switchModeText: { color: '#64748B', fontSize: 14 },
  linkText: { color: '#2563EB', fontSize: 14, fontWeight: 'bold' }
});