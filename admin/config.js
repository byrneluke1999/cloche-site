// The Supabase project the admin page talks to. The key is the publishable (anon) key, the same
// one the app ships with: it is public by design, and row level security is what protects the
// data. The powerful service-role key must never be put in this file or anywhere on the site.
export const SUPABASE_URL = 'https://djmgqpscxakiknquzdcd.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_ji26gDCdMLjDrp3siGq3oA_2XDfLRKi';

// The one admin. Sign-in asks only for a password; the database decides who is really an admin.
export const ADMIN_EMAIL = 'byrneluke1999@gmail.com';
