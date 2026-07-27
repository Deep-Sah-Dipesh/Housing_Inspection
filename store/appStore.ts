import { create } from 'zustand';

interface AppState {
  userId: string | null;
  userName: string | null;
  setAuth: (id: string, name: string) => void;
  logout: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  userId: null,
  userName: null,
  setAuth: (id, name) => set({ userId: id, userName: name }),
  logout: () => set({ userId: null, userName: null }),
}));