import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import adminApi from '@/lib/admin-axios';
import { auth } from '@/lib/firebase';
import { onAuthStateChanged, sendEmailVerification, signInWithEmailAndPassword, signOut } from 'firebase/auth';

export const AdminAuthContext = createContext(null);
const permissions = {
  super_admin: ['*'],
  admin: ['view:users', 'update:users', 'view:jobs', 'create:jobs', 'update:jobs', 'delete:jobs',
    'view:templates', 'create:templates', 'update:templates', 'delete:templates',
    'view:payments', 'view:scraper', 'run:scraper', 'view:prompts', 'update:prompts',
    'view:logs', 'view:analytics', 'view:settings', 'update:settings'],
  content_manager: ['view:jobs', 'create:jobs', 'update:jobs', 'delete:jobs',
    'view:templates', 'create:templates', 'update:templates', 'delete:templates',
    'view:scraper', 'run:scraper'],
  support: ['view:users', 'update:users', 'view:payments', 'refund:payments', 'view:logs'],
};

export const AdminAuthProvider = ({ children }) => {
  const [admin, setAdmin] = useState(null);
  const [isLoading, setLoading] = useState(Boolean(auth));
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!auth) return undefined;
    return onAuthStateChanged(auth, async user => {
      if (!user?.emailVerified) { setAdmin(null); setLoading(false); return; }
      try { const { data } = await adminApi.get('/admin/auth/me'); setAdmin(data.admin); }
      catch { setAdmin(null); }
      finally { setLoading(false); }
    });
  }, []);
  const value = useMemo(() => ({
    admin, isAdminAuthenticated: Boolean(admin), isLoading, error,
    adminRole: admin?.role || null, isSuperAdmin: admin?.role === 'super_admin',
    isAdmin: Boolean(admin),
    hasPermission: permission => Boolean(admin &&
      ((permissions[admin.role] || []).includes('*') || (permissions[admin.role] || []).includes(permission))),
    clearError: () => setError(null),
    adminLogin: async ({ email, password }) => {
      if (!auth) return { success: false, message: 'Sign-in is temporarily unavailable. Please try again later.' };
      try {
        const credential = await signInWithEmailAndPassword(auth, email, password);
        if (!credential.user.emailVerified) {
          await sendEmailVerification(credential.user);
          await signOut(auth);
          throw new Error('Verify your email using the link we sent, then sign in.');
        }
        const { data } = await adminApi.get('/admin/auth/me');
        setAdmin(data.admin); setError(null);
        return { success: true, role: data.admin.role };
      } catch (cause) {
        await signOut(auth).catch(() => {});
        const message = cause.response?.data?.message || cause.message || 'Admin login failed';
        setAdmin(null); setError(message); return { success: false, message };
      }
    },
    adminLogout: async () => { if (auth) await signOut(auth); setAdmin(null); },
  }), [admin, error, isLoading]);
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
};
export const useAdminAuth = () => {
  const context = useContext(AdminAuthContext);
  if (!context) throw new Error('useAdminAuth must be used inside <AdminAuthProvider>');
  return context;
};
