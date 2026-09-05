import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface AppState {
  userId: string | null;
  userName: string | null;
  district: string | null;
  city: string | null;
  _hasHydrated: boolean;
  setAuth: (id: string, name: string) => void;
  logout: () => void;
  setFilters: (district: string | null, city: string | null) => void;
  clearFilters: () => void;
  setHasHydrated: (state: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      userId: null,
      userName: null,
      district: null,
      city: null,
      _hasHydrated: false,

      setAuth: (id: string, name: string) => set({ userId: id, userName: name }),
      logout: () => set({ userId: null, userName: null, district: null, city: null }),
      setFilters: (district: string | null, city: string | null) => set({ district, city }),
      clearFilters: () => set({ district: null, city: null }),
      setHasHydrated: (state: boolean) => set({ _hasHydrated: state }),
    }),
    {
      name: 'housing-inspection-storage',
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);