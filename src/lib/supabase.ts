import { createClient } from "@supabase/supabase-js";

// Vercel build-time safety check: use dummy values if env variables are not set yet
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://dummy-project-id.supabase.co";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
  "dummy-anon-key";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  console.warn("Supabase credentials missing in environment. Using dummy values for compilation safety.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

