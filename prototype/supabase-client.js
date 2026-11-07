// Load this file after shared.js, or from a page script.
// The browser receives only the Supabase publishable key. RLS is still mandatory.
(function (global) {
  "use strict";

  global.RGMS_SUPABASE_READY = (async function () {
    const configResponse = await fetch("/api/supabase-config", {
      method: "GET",
      headers: { "Accept": "application/json" },
      cache: "no-store"
    });

    if (!configResponse.ok) {
      const detail = await configResponse.json().catch(() => ({}));
      throw new Error(detail.error || "Could not load Supabase configuration.");
    }

    const config = await configResponse.json();
    if (!config.supabaseUrl || !config.publishableKey) {
      throw new Error("Supabase URL or publishable key is missing.");
    }

    // Use Supabase's official browser ESM build; no bundler is required for this static prototype.
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2"
    );

    const client = createClient(config.supabaseUrl, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });

    global.RGMS_SUPABASE = client;
    return client;
  })();

  global.RGMS_SUPABASE_READY.catch(function (error) {
    console.error("[RGMS] Supabase initialization failed:", error);
  });
})(window);
