import { start } from './admin.js';
import { SUPABASE_KEY, SUPABASE_URL } from './config.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'cloche-admin-auth',
  },
});

start(sb, document.getElementById('app'));
