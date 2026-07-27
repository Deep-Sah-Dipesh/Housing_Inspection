import React, { Component, ReactNode, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import * as FileSystem from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { initDatabase } from '../utils/database';

// ------------------------------------------------------------------
// 1. Error Boundary to catch the exact 'replace of undefined' crash
// ------------------------------------------------------------------
class SQLiteErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean, error: string}> {
  state = { hasError: false, error: '' };

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error: error.message || String(error) };
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30, backgroundColor: '#FEF2F2' }}>
          <Ionicons name="warning" size={60} color="#EF4444" style={{marginBottom: 20}} />
          <Text style={{ color: '#EF4444', fontSize: 22, fontWeight: 'bold', marginBottom: 15, textAlign: 'center' }}>
            Wrong App Launched
          </Text>
          <Text style={{ color: '#1E293B', fontSize: 16, textAlign: 'center', lineHeight: 24, marginBottom: 20 }}>
            The error <Text style={{fontWeight: 'bold', color: '#B91C1C'}}>"{this.state.error}"</Text> means your phone opened standard Expo Go instead of your custom Development Build.
          </Text>
          <Text style={{ color: '#1E293B', fontSize: 16, textAlign: 'center', lineHeight: 28, fontWeight: 'bold' }}>
            1. Close this app completely.{"\n"}
            2. Go to your phone's Home Screen.{"\n"}
            3. Tap the "Housing Inspection" app directly.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

// ------------------------------------------------------------------
// 2. Main Root Layout
// ------------------------------------------------------------------
export default function RootLayout() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Artificial delay to ensure FileSystem is mounted before SQLite fires
    setTimeout(() => {
      setIsReady(true);
    }, 500);
  }, []);

  if (!isReady) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC' }}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={{ marginTop: 15, color: '#64748B', fontWeight: 'bold' }}>Initializing Secure Workspace...</Text>
      </View>
    );
  }

  return (
    <SQLiteErrorBoundary>
      <SQLiteProvider databaseName="housing.db" onInit={initDatabase}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(tabs)" options={{ gestureEnabled: false }} />
          <Stack.Screen name="beneficiary/[id]" />
        </Stack>
      </SQLiteProvider>
    </SQLiteErrorBoundary>
  );
}