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

    if (!env.SPORTMONKS_API_TOKEN) {
      return reply({ error: "Sportmonks API token is not configured" }, 500);
    }

    const date = url.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply({ error: "Date must use YYYY-MM-DD format" }, 400);
    }

    const cache = caches.default;
    const cacheKey = new Request("https://judy-ai-cache.example/sportmonks/matches/" + date);
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

    const apiUrl = new URL("https://api.sportmonks.com/v3/football/fixtures/date/" + date);
    apiUrl.searchParams.set("api_token", env.SPORTMONKS_API_TOKEN);
    apiUrl.searchParams.set("include", "participants;league;state;venue");
    apiUrl.searchParams.set("per_page", "50");

    try {
      const upstream = await fetch(apiUrl.toString(), {
        headers: { "Accept": "application/json" }
      });

      const raw = await upstream.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return reply({
          error: "Sportmonks returned an unreadable response",
          providerStatus: upstream.status
        }, 502);
      }

      if (!upstream.ok) {
        return reply({
          error: "Sportmonks request failed",
          providerStatus: upstream.status,
          details: data
        }, upstream.status);
      }

      const matches = Array.isArray(data.data) ? data.data : [];
      const result = {
        app: "JUDY AI",
        success: true,
        provider: "Sportmonks",
        date,
        timezone: "Africa/Nairobi",
        total: matches.length,
        pagination: data.pagination || null,
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
        error: "Could not connect to Sportmonks",
        details: error.message
      }, 502);
    }
  }
};
