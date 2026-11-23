const WEBSITE_ORIGIN = "https://judy-ai-backend-live.djskinking.workers.dev";
const CACHE_TTL = 900;

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": WEBSITE_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Serve the website (HTML, CSS, and JavaScript) from the configured
    // Workers Static Assets directory. Keep /api/* handled by this Worker.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": WEBSITE_ORIGIN,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname !== "/api/matches") {
      return reply({ error: "Route not found" }, 404);
    }

    if (request.method !== "GET") {
      return reply({ error: "GET method required" }, 405);
    }

    if (!env.HIGHLIGHTLY_API_KEY) {
      return reply({ error: "Highlightly API key is not configured" }, 500);
    }

    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply({ error: "Date must use YYYY-MM-DD format" }, 400);
    }

    const cache = caches.default;
    const cacheKey = new Request("https://judy-ai-cache.example/matches/" + date);
    const cached = await cache.match(cacheKey);

    if (cached) {
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          ...Object.fromEntries(cached.headers),
          "Access-Control-Allow-Origin": WEBSITE_ORIGIN
        }
      });
    }

    const apiUrl = new URL("https://soccer.highlightly.net/matches");
    apiUrl.searchParams.set("date", date);
    apiUrl.searchParams.set("timezone", "Africa/Nairobi");
    apiUrl.searchParams.set("limit", "100");

    try {
      const upstream = await fetch(apiUrl.toString(), {
        headers: {
          "x-rapidapi-key": env.HIGHLIGHTLY_API_KEY,
          "Accept": "application/json"
        }
      });

      const raw = await upstream.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return reply({
          error: "Highlightly returned an invalid response",
          providerStatus: upstream.status
        }, 502);
      }

      if (!upstream.ok) {
        return reply({
          error: "Highlightly request failed",
          providerStatus: upstream.status,
          details: data
        }, upstream.status);
      }

      let matches = [];
      if (Array.isArray(data)) matches = data;
      else if (Array.isArray(data.data)) matches = data.data;
      else if (Array.isArray(data.matches)) matches = data.matches;
      else if (Array.isArray(data.response)) matches = data.response;

      const result = {
        app: "JUDY AI",
        success: true,
        provider: "Highlightly",
        date,
        timezone: "Africa/Nairobi",
        total: matches.length,
        fixtures: matches,
        matches
      };

      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=" + CACHE_TTL
        }
      })));

      return reply(result);
    } catch (error) {
      return reply({
        error: "Could not connect to Highlightly",
        details: error.message
      }, 502);
    }
  }
};
