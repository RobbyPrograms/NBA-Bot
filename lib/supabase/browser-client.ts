import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let singleton: SupabaseClient | null | undefined;

/** Browser-only. Returns null if NEXT_PUBLIC_SUPABASE_* are unset. */
export function getBrowserSupabase(): SupabaseClient | null {
  if (singleton !== undefined) return singleton;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    singleton = null;
    return null;
  }
  singleton = createClient(url, key);
  return singleton;
}

export function isSupabaseBrowserConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim(),
  );
}
