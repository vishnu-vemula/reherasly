import { create } from 'zustand';
import {
  createUserWithEmailAndPassword, EmailAuthProvider, GoogleAuthProvider, onAuthStateChanged,
  reauthenticateWithCredential, reauthenticateWithPopup, updatePassword,
  sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword,
  signInWithPopup, signOut, updateProfile,
  confirmPasswordReset as confirmFirebasePasswordReset,
} from 'firebase/auth';
import { auth } from '@/lib/firebase';
import api from '@/lib/axios';
import { getErrorMessage } from '@/utils';

const firebaseMessage = (error, fallback) => {
  if (!auth) return 'Sign-in is temporarily unavailable. Please try again later.';
  const code = error?.code || '';
  if (code === 'auth/email-already-in-use') return 'An account with this email already exists.';
  if (code === 'auth/invalid-credential') return 'Invalid email or password.';
  if (code === 'auth/weak-password') return 'Choose a stronger password.';
  if (code === 'auth/popup-closed-by-user') return 'Google sign-in was canceled.';
  return getErrorMessage(error, fallback);
};

const syncUser = async () => {
  const requestedUid = auth?.currentUser?.uid;
  if (!requestedUid) throw new Error('Sign-in session changed. Please try again.');
  const { data } = await api.post('/auth/firebase/session');
  if (auth?.currentUser?.uid !== requestedUid) {
    throw new Error('Sign-in session changed. Please try again.');
  }
  useFirebaseAuthStore.setState({ user: data.user, isAuthenticated: true, isLoading: false });
  return data.user;
};

export const useFirebaseAuthStore = create((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: Boolean(auth),
  login: async ({ email, password }) => {
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
        await signOut(auth);
        set({ isLoading: false });
        return { success: false, message: 'Verify your email using the link we sent, then sign in.' };
      }
      await syncUser();
      return { success: true };
    } catch (error) {
      set({ isLoading: false });
      return { success: false, status: error.response?.status, message: firebaseMessage(error, 'Sign-in failed') };
    }
  },
  register: async ({ name, email, password }) => {
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(credential.user, { displayName: name });
      await sendEmailVerification(credential.user);
      await signOut(auth);
      set({ isLoading: false });
      return { success: true, verificationRequired: true };
    } catch (error) {
      set({ isLoading: false });
      return { success: false, status: error.response?.status, message: firebaseMessage(error, 'Registration failed') };
    }
  },
  googleLogin: async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      await syncUser();
      return { success: true };
    } catch (error) {
      set({ isLoading: false });
      return { success: false, status: error.response?.status, message: firebaseMessage(error, 'Google sign-in failed') };
    }
  },
  resetPassword: async (email) => {
    try {
      await sendPasswordResetEmail(auth, email);
      return { success: true };
    } catch (error) {
      return { success: false, message: firebaseMessage(error, 'Could not send a reset email') };
    }
  },
  confirmPasswordReset: async ({ token, password }) => {
    try { await confirmFirebasePasswordReset(auth, token, password);
      return { success: true }; }
    catch (error) { return { success: false, status: 400,
      message: firebaseMessage(error, 'Reset link expired or invalid') }; }
  },
  changeFirebasePassword: async ({ currentPassword, newPassword }) => {
    const current = auth.currentUser;
    if (!current?.email) throw new Error('Sign in again to change your password.');
    await reauthenticateWithCredential(current, EmailAuthProvider.credential(current.email, currentPassword));
    await updatePassword(current, newPassword);
  },
  deleteFirebaseAccount: async (currentPassword) => {
    const current = auth.currentUser;
    if (!current?.email) throw new Error('Sign in again to delete your account.');
    if (current.providerData.some((provider) => provider.providerId === 'password')) {
      await reauthenticateWithCredential(current, EmailAuthProvider.credential(current.email, currentPassword));
    } else {
      await reauthenticateWithPopup(current, new GoogleAuthProvider());
    }
    await current.getIdToken(true);
    await api.delete('/auth/firebase/account');
    set({ user: null, isAuthenticated: false });
    await signOut(auth).catch(() => {});
  },
  logout: async () => {
    await signOut(auth);
    set({ user: null, isAuthenticated: false });
  },
  updateUser: (updatedUser) => set({ user: { ...get().user, ...updatedUser } }),
}));

if (auth) {
  let observedAuthVersion = 0;
  onAuthStateChanged(auth, async (firebaseUser) => {
    const version = ++observedAuthVersion;
    if (!firebaseUser || !firebaseUser.emailVerified) {
      useFirebaseAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
      return;
    }
    try { await syncUser(); }
    catch {
      if (version === observedAuthVersion) {
        useFirebaseAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
      }
    }
  });
}
