import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface AppState {
  userId: string | null;
  userName: string | null;
  isSyncing: boolean;
  _hasHydrated: boolean;
  
  setAuth: (id: string, name: string) => void;
  logout: () => void;
  setSyncing: (status: boolean) => void;
  setHasHydrated: (state: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      userId: null,
      userName: null,
      isSyncing: false,
      _hasHydrated: false,
      
      setAuth: (id, name) => set({ userId: id, userName: name }),
      
      logout: () => set({ userId: null, userName: null }),
      
      setSyncing: (status) => set({ isSyncing: status }),

      setHasHydrated: (state) => set({ _hasHydrated: state }),
    }),
    {
      name: 'housing-inspection-storage', // The unique key for local storage
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state) => {
        // When AsyncStorage finishes loading the saved data from the hard drive,
        // we tell the app it is ready to skip the login screen.
        if (state) {
          state.setHasHydrated(true);
        }
      },
    }
  )
);