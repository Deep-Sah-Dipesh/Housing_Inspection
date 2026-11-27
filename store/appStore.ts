import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deriveAuthorId } from '../utils/authorHelpers';

interface SavedOfficialNameEntry {
  name: string;
  locked: boolean;
}

interface AppState {
  userId: string | null;
  authorId: string | null;
  userName: string | null;
  officialName: string | null;
  officialNameLocked: boolean;
  officialNameByUser: Record<string, SavedOfficialNameEntry>;
  district: string | null;
  city: string | null;
  _hasHydrated: boolean;
  seedSyncVersion: number;
  isSeedSyncing: boolean;
  setAuth: (id: string, name: string, authorId?: string | null, defaultOfficialName?: string | null) => void;
  setOfficialName: (name: string, lock?: boolean) => void;
  lockOfficialName: () => void;
  logout: () => void;
  setFilters: (district: string | null, city: string | null) => void;
  clearFilters: () => void;
  setHasHydrated: (state: boolean) => void;
  setSeedSyncing: (syncing: boolean) => void;
  bumpSeedSyncVersion: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      userId: null,
      authorId: null,
      userName: null,
      officialName: null,
      officialNameLocked: false,
      officialNameByUser: {},
      district: null,
      city: null,
      _hasHydrated: false,
      seedSyncVersion: 0,
      isSeedSyncing: false,

      setAuth: (
        id: string,
        name: string,
        explicitAuthorId?: string | null,
        defaultOfficialName?: string | null
      ) =>
        set((state) => {
          const cleanId = id.toLowerCase().trim();
          const resolvedAuthorId = (explicitAuthorId?.trim() || deriveAuthorId(cleanId)) || cleanId;
          const savedEntry = state.officialNameByUser?.[resolvedAuthorId];

          const nextOfficialName =
            savedEntry?.name?.trim() ||
            defaultOfficialName?.trim() ||
            (state.userId === cleanId ? state.officialName : null) ||
            name.trim() ||
            null;
          const nextLocked = savedEntry
            ? savedEntry.locked
            : state.userId === cleanId
              ? state.officialNameLocked
              : false;

          return {
            userId: cleanId,
            authorId: resolvedAuthorId,
            userName: name.trim() || cleanId,
            officialName: nextOfficialName,
            officialNameLocked: nextLocked,
          };
        }),

      setOfficialName: (name: string, lock = true) =>
        set((state) => {
          if (state.officialNameLocked) {
            return state;
          }
          const trimmed = name.trim();
          if (!trimmed) return state;

          const key = state.authorId || deriveAuthorId(state.userId);
          const nextMap = { ...state.officialNameByUser };
          if (key) {
            nextMap[key] = { name: trimmed, locked: lock };
          }
          return {
            officialName: trimmed,
            officialNameLocked: lock,
            officialNameByUser: nextMap,
          };
        }),

      lockOfficialName: () =>
        set((state) => {
          const currentName = (state.officialName || state.userName || '').trim();
          if (!currentName) return state;
          const key = state.authorId || deriveAuthorId(state.userId);
          const nextMap = { ...state.officialNameByUser };
          if (key) {
            nextMap[key] = { name: currentName, locked: true };
          }
          return {
            officialName: currentName,
            officialNameLocked: true,
            officialNameByUser: nextMap,
          };
        }),

      logout: () =>
        set({
          userId: null,
          authorId: null,
          userName: null,
          officialName: null,
          officialNameLocked: false,
          district: null,
          city: null,
        }),

      setFilters: (district: string | null, city: string | null) => set({ district, city }),
      clearFilters: () => set({ district: null, city: null }),
      setHasHydrated: (state: boolean) => set({ _hasHydrated: state }),
      setSeedSyncing: (syncing: boolean) => set({ isSeedSyncing: syncing }),
      bumpSeedSyncVersion: () => set((state) => ({ seedSyncVersion: state.seedSyncVersion + 1 })),
    }),
    {
      name: 'housing-inspection-storage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        userId: state.userId,
        authorId: state.authorId,
        userName: state.userName,
        officialName: state.officialName,
        officialNameLocked: state.officialNameLocked,
        officialNameByUser: state.officialNameByUser,
        district: state.district,
        city: state.city,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          if (state.userId && !state.authorId) {
            const derived = deriveAuthorId(state.userId);
            useAppStore.setState({ authorId: derived || state.userId });
          }
          if (state.officialName && state.officialName.trim().length > 0 && !state.officialNameLocked) {
            // Backward compatibility: legacy persisted officialName was locked upon first backup
            const key = state.authorId || deriveAuthorId(state.userId);
            const hasExplicitEntry = key ? Boolean(state.officialNameByUser?.[key]) : false;
            if (!hasExplicitEntry) {
              useAppStore.setState({ officialNameLocked: true });
            }
          }
          state.setHasHydrated(true);
        } else {
          useAppStore.setState({ _hasHydrated: true });
        }
      },
    }
  )
);