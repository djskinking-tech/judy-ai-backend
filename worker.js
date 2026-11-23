const WEBSITE_ORIGIN = "https://judy-ai-backend-live.djskinking.workers.dev";
const CACHE_TTL = 900;


function poissonProb(lambda, goals) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= goals; i++) p *= lambda / i;
  return p;
}

function topScoreOptions(homeLambda, awayLambda) {
  const options = [];
  for (let home = 0; home <= 8; home++) {
    for (let away = 0; away <= 8; away++) {
      options.push({
        score: home + "-" + away,
        probability: poissonProb(homeLambda, home) * poissonProb(awayLambda, away)
      });
    }
  }
  return options.sort((a, b) => b.probability - a.probability).slice(0, 2)
    .map((item, index) => ({
      rank: index + 1,
      score: item.score,
      probability: Number((item.probability * 100).toFixed(2))
    }));
}

function goalsForAgainst(fixture, teamId, period) {
  const scores = Array.isArray(fixture.scores) ? fixture.scores : [];
  const periodRows = scores.filter(s => s.description === period);
  if (!periodRows.length) return null;
  const teamRow = periodRows.find(s => Number(s.participant_id) === Number(teamId));
  if (!teamRow || !teamRow.score) return null;
  const teamSide = teamRow.score.participant;
  const opponentRow = periodRows.find(s => s.score && s.score.participant !== teamSide);
  if (!opponentRow || !Number.isFinite(Number(teamRow.score.goals)) ||
      !Number.isFinite(Number(opponentRow.score.goals))) return null;
  return {
    scored: Number(teamRow.score.goals),
    conceded: Number(opponentRow.score.goals)
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

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

    if (url.pathname === "/api/diagnostics") {
      return reply({
        app: "JUDY AI",
        sportmonksTokenConfigured: Boolean(env.SPORTMONKS_API_TOKEN),
        availableBindingNames: Object.keys(env)
      });
    }

    if (url.pathname === "/api/backtest") {
      if (request.method !== "GET") return reply({ error: "GET method required" }, 405);
      if (!env.SPORTMONKS_API_TOKEN) return reply({ error: "Sportmonks API token is not configured" }, 500);

      let rawIds = (url.searchParams.get("fixtureIds") || "").split(",").map(v => v.trim()).filter(Boolean);
      const dateParam = url.searchParams.get("date");
      const limit = Math.max(1, Math.min(2, Number(url.searchParams.get("limit") || 2)));
      if (rawIds.length && (dateParam || rawIds.length > 5 || rawIds.some(id => !/^[0-9]+$/.test(id)))) {
        return reply({ error: "Use either fixtureIds (1 to 5 IDs) or date (YYYY-MM-DD), not both." }, 400);
      }
      if (!rawIds.length && (!dateParam || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dateParam))) {
        return reply({ error: "Provide fixtureIds or a past date in YYYY-MM-DD format." }, 400);
      }

      async function sportmonks(path, params = {}) {
        const apiUrl = new URL("https://api.sportmonks.com/v3/football/" + path);
        apiUrl.searchParams.set("api_token", env.SPORTMONKS_API_TOKEN);
        for (const [key, value] of Object.entries(params)) apiUrl.searchParams.set(key, value);
        const response = await fetch(apiUrl.toString(), { headers: { "Accept": "application/json" } });
        const raw = await response.text();
        let body;
        try { body = JSON.parse(raw); } catch { throw new Error("Sportmonks returned unreadable data (HTTP " + response.status + ")."); }
        if (!response.ok) {
          const error = new Error("Sportmonks request failed (HTTP " + response.status + ").");
          error.status = response.status;
          error.details = body;
          throw error;
        }
        return body.data;
      }

      function weightedAverage(values, weights) {
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        return totalWeight ? values.reduce((sum, value, index) => sum + value * weights[index], 0) / totalWeight : null;
      }

      function periodAverages(form, key, preferredVenue, kickoff) {
        const venueRows = form.filter(item => item.venue === preferredVenue && item[key]);
        const useVenueSplit = venueRows.length >= 3;
        const selected = useVenueSplit ? venueRows : form.filter(item => item[key]);
        const rows = selected.map(item => {
          const matchDate = new Date(String(item.date || "").replace(" ", "T") + "Z");
          const ageDays = Number.isNaN(matchDate.getTime()) ? 0 :
            Math.max(0, (kickoff.getTime() - matchDate.getTime()) / 86400000);
          return { stats: item[key], weight: Math.exp(-Math.LN2 * ageDays / 45) };
        });
        const weights = rows.map(row => row.weight);
        return {
          scored: weightedAverage(rows.map(row => row.stats.scored), weights),
          conceded: weightedAverage(rows.map(row => row.stats.conceded), weights),
          venueMatches: venueRows.length,
          venueSplitUsed: useVenueSplit
        };
      }

      function scoreText(home, away) {
        return home && away ? home.scored + "-" + away.scored : null;
      }

      const tested = [];
      try {
        if (!rawIds.length) {
          const dayFixtures = await sportmonks("fixtures/date/" + dateParam, {
            include: "participants;league;scores;state", per_page: "50"
          });
          const finished = (Array.isArray(dayFixtures) ? dayFixtures : []).filter(f => {
            const stateName = f.state && String(f.state.name || "").toLowerCase();
            const ft = Array.isArray(f.scores) && f.scores.some(s =>
              (s.description === "CURRENT" || s.description === "2ND_HALF") &&
              Number.isFinite(Number(s.score && s.score.goals))
            );
            return ft && stateName !== "not started" && stateName !== "ns";
          });
          rawIds = finished.slice(0, limit).map(f => String(f.id));
        }
        if (!rawIds.length) {
          return reply({
            app: "JUDY AI", success: true, mode: "historical_backtest",
            warning: "No completed fixtures with full-time score data were found for this date.",
            requestedFixtures: 0, testedFixtures: 0, skippedFixtures: [],
            metrics: { fullTimeExactScoreHits: 0, fullTimeExactScoreAccuracyPercent: null,
              fullTimeTopTwoHits: 0, fullTimeTopTwoAccuracyPercent: null,
              halfTimeFixturesWithResults: 0, halfTimeExactScoreHits: 0,
              halfTimeExactScoreAccuracyPercent: null, halfTimeTopTwoHits: 0,
              halfTimeTopTwoAccuracyPercent: null }, results: []
          });
        }
        for (const fixtureId of rawIds) {
          const target = await sportmonks("fixtures/" + fixtureId, {
            include: "participants;league;scores;state"
          });
          if (!target || !Array.isArray(target.participants)) {
            tested.push({ fixtureId, status: "fixture_not_found" });
            continue;
          }
          const homeTeam = target.participants.find(p => p.meta && p.meta.location === "home");
          const awayTeam = target.participants.find(p => p.meta && p.meta.location === "away");
          if (!homeTeam || !awayTeam) {
            tested.push({ fixtureId, status: "team_data_missing" });
            continue;
          }

          const kickoff = new Date(String(target.starting_at).replace(" ", "T") + "Z");
          if (Number.isNaN(kickoff.getTime())) {
            tested.push({ fixtureId, status: "invalid_kickoff" });
            continue;
          }
          const endDate = target.starting_at.slice(0, 10);
          const startDate = new Date(kickoff.getTime() - 180 * 86400000).toISOString().slice(0, 10);
          const [homeHistory, awayHistory] = await Promise.all([
            sportmonks("fixtures/between/" + startDate + "/" + endDate + "/" + homeTeam.id, {
              include: "scores;participants", per_page: "50", order: "desc"
            }),
            sportmonks("fixtures/between/" + startDate + "/" + endDate + "/" + awayTeam.id, {
              include: "scores;participants", per_page: "50", order: "desc"
            })
          ]);

          function recentForm(rows, teamId) {
            return (Array.isArray(rows) ? rows : [])
              .filter(f => Number(f.id) !== Number(fixtureId) &&
                new Date(String(f.starting_at || "").replace(" ", "T") + "Z").getTime() < kickoff.getTime())
              .map(f => {
                const participant = Array.isArray(f.participants)
                  ? f.participants.find(p => Number(p.id) === Number(teamId)) : null;
                return {
                  ft: goalsForAgainst(f, teamId, "CURRENT") || goalsForAgainst(f, teamId, "2ND_HALF"),
                  ht: goalsForAgainst(f, teamId, "1ST_HALF"),
                  date: f.starting_at,
                  venue: participant && participant.meta ? participant.meta.location : null
                };
              })
              .filter(f => f.ft)
              .sort((a, b) => String(b.date).localeCompare(String(a.date)))
              .slice(0, 8);
          }

          const homeForm = recentForm(homeHistory, homeTeam.id);
          const awayForm = recentForm(awayHistory, awayTeam.id);
          if (homeForm.length < 3 || awayForm.length < 3) {
            tested.push({
              fixtureId, match: target.name, status: "insufficient_history",
              sampleSize: { home: homeForm.length, away: awayForm.length }
            });
            continue;
          }

          const hft = periodAverages(homeForm, "ft", "home", kickoff);
          const aft = periodAverages(awayForm, "ft", "away", kickoff);
          const hht = periodAverages(homeForm, "ht", "home", kickoff);
          const aht = periodAverages(awayForm, "ht", "away", kickoff);
          const expectedGoals = (attack, defence) => Math.max(0.05, Math.min(4.5, (attack + defence) / 2));
          const ftHome = expectedGoals(hft.scored, aft.conceded);
          const ftAway = expectedGoals(aft.scored, hft.conceded);
          const htReady = hht.scored !== null && aht.scored !== null &&
            hht.conceded !== null && aht.conceded !== null;
          const ftOptions = topScoreOptions(ftHome, ftAway);
          const htOptions = htReady ? topScoreOptions(
            expectedGoals(hht.scored, aht.conceded),
            expectedGoals(aht.scored, hht.conceded)
          ) : null;

          const actualHomeFT = goalsForAgainst(target, homeTeam.id, "CURRENT") ||
            goalsForAgainst(target, homeTeam.id, "2ND_HALF");
          const actualAwayFT = goalsForAgainst(target, awayTeam.id, "CURRENT") ||
            goalsForAgainst(target, awayTeam.id, "2ND_HALF");
          const actualHomeHT = goalsForAgainst(target, homeTeam.id, "1ST_HALF");
          const actualAwayHT = goalsForAgainst(target, awayTeam.id, "1ST_HALF");
          const actualFT = scoreText(actualHomeFT, actualAwayFT);
          const actualHT = scoreText(actualHomeHT, actualAwayHT);

          if (!actualFT) {
            tested.push({ fixtureId, match: target.name, status: "actual_result_not_available" });
            continue;
          }
          tested.push({
            fixtureId,
            match: target.name,
            kickoff: target.starting_at,
            league: target.league && target.league.name,
            status: "tested",
            sampleSize: { home: homeForm.length, away: awayForm.length },
            actual: { fullTime: actualFT, halfTime: actualHT },
            predicted: { fullTime: ftOptions, halfTime: htOptions },
            hits: {
              fullTimeExact: ftOptions[0] && ftOptions[0].score === actualFT,
              fullTimeTopTwo: ftOptions.some(option => option.score === actualFT),
              halfTimeExact: actualHT ? Boolean(htOptions && htOptions[0] && htOptions[0].score === actualHT) : null,
              halfTimeTopTwo: actualHT ? Boolean(htOptions && htOptions.some(option => option.score === actualHT)) : null
            }
          });
        }

        const completed = tested.filter(item => item.status === "tested");
        const countHits = key => completed.filter(item => item.hits[key] === true).length;
        const rate = hits => completed.length ? Number((hits / completed.length * 100).toFixed(2)) : null;
        const htCompleted = completed.filter(item => item.actual.halfTime);
        const htHits = htCompleted.filter(item => item.hits.halfTimeExact === true).length;
        const htTopTwoHits = htCompleted.filter(item => item.hits.halfTimeTopTwo === true).length;
        return reply({
          app: "JUDY AI",
          success: true,
          mode: "historical_backtest",
          warning: "Small-sample experimental test only. Predictions use only matches strictly before each fixture's kickoff; results are not proof of future accuracy.",
          requestedFixtures: rawIds.length,
          testedFixtures: completed.length,
          skippedFixtures: tested.filter(item => item.status !== "tested"),
          metrics: {
            fullTimeExactScoreHits: countHits("fullTimeExact"),
            fullTimeExactScoreAccuracyPercent: rate(countHits("fullTimeExact")),
            fullTimeTopTwoHits: countHits("fullTimeTopTwo"),
            fullTimeTopTwoAccuracyPercent: rate(countHits("fullTimeTopTwo")),
            halfTimeFixturesWithResults: htCompleted.length,
            halfTimeExactScoreHits: htHits,
            halfTimeExactScoreAccuracyPercent: htCompleted.length ? Number((htHits / htCompleted.length * 100).toFixed(2)) : null,
            halfTimeTopTwoHits: htTopTwoHits,
            halfTimeTopTwoAccuracyPercent: htCompleted.length ? Number((htTopTwoHits / htCompleted.length * 100).toFixed(2)) : null
          },
          results: completed
        });
      } catch (error) {
        return reply({
          error: error.message || "Historical backtest failed",
          providerStatus: error.status || null,
          details: error.details || null
        }, error.status || 502);
      }
    }

    if (url.pathname === "/api/predictions") {
      if (request.method !== "GET") return reply({ error: "GET method required" }, 405);
      if (!env.SPORTMONKS_API_TOKEN) return reply({ error: "Sportmonks API token is not configured" }, 500);
      const fixtureId = url.searchParams.get("fixtureId");
      if (!fixtureId || !/^\d+$/.test(fixtureId)) {
        return reply({ error: "A valid fixtureId is required" }, 400);
      }

      const cache = caches.default;
      const cacheKey = new Request("https://judy-ai-cache.example/sportmonks/predictions/v2/" + fixtureId);
      const cached = await cache.match(cacheKey);
      if (cached) return new Response(cached.body, {
        status: cached.status,
        headers: { ...Object.fromEntries(cached.headers), "Access-Control-Allow-Origin": WEBSITE_ORIGIN }
      });

      async function sportmonks(path, params = {}) {
        const apiUrl = new URL("https://api.sportmonks.com/v3/football/" + path);
        apiUrl.searchParams.set("api_token", env.SPORTMONKS_API_TOKEN);
        for (const [key, value] of Object.entries(params)) apiUrl.searchParams.set(key, value);
        const response = await fetch(apiUrl.toString(), { headers: { "Accept": "application/json" } });
        const raw = await response.text();
        let body;
        try { body = JSON.parse(raw); } catch { throw new Error("Sportmonks returned unreadable data (HTTP " + response.status + ")."); }
        if (!response.ok) {
          const error = new Error("Sportmonks request failed (HTTP " + response.status + ").");
          error.status = response.status;
          error.details = body;
          throw error;
        }
        return body.data;
      }

      try {
        const target = await sportmonks("fixtures/" + fixtureId, { include: "participants;league" });
        if (!target || !Array.isArray(target.participants)) {
          return reply({ error: "Fixture or participant data was not found." }, 404);
        }
        const homeTeam = target.participants.find(p => p.meta && p.meta.location === "home");
        const awayTeam = target.participants.find(p => p.meta && p.meta.location === "away");
        if (!homeTeam || !awayTeam) return reply({ error: "Could not identify both teams for this fixture." }, 422);

        const kickoff = new Date(String(target.starting_at).replace(" ", "T") + "Z");
        if (Number.isNaN(kickoff.getTime())) return reply({ error: "Fixture kick-off date is invalid." }, 422);
        const endDate = target.starting_at.slice(0, 10);
        const start = new Date(kickoff.getTime() - 180 * 86400000).toISOString().slice(0, 10);

        const [homeHistory, awayHistory] = await Promise.all([
          sportmonks("fixtures/between/" + start + "/" + endDate + "/" + homeTeam.id, {
            include: "scores;participants", per_page: "50", order: "desc"
          }),
          sportmonks("fixtures/between/" + start + "/" + endDate + "/" + awayTeam.id, {
            include: "scores;participants", per_page: "50", order: "desc"
          })
        ]);

        function recentForm(rows, teamId) {
          return (Array.isArray(rows) ? rows : [])
            .filter(f => Number(f.id) !== Number(fixtureId))
            .map(f => {
              const participant = Array.isArray(f.participants)
                ? f.participants.find(p => Number(p.id) === Number(teamId))
                : null;
              return {
                ft: goalsForAgainst(f, teamId, "CURRENT") || goalsForAgainst(f, teamId, "2ND_HALF"),
                ht: goalsForAgainst(f, teamId, "1ST_HALF"),
                date: f.starting_at,
                venue: participant && participant.meta ? participant.meta.location : null
              };
            })
            .filter(f => f.ft)
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
            .slice(0, 8);
        }

        const homeForm = recentForm(homeHistory, homeTeam.id);
        const awayForm = recentForm(awayHistory, awayTeam.id);
        if (homeForm.length < 3 || awayForm.length < 3) {
          return reply({
            app: "JUDY AI",
            success: false,
            status: "insufficient_history",
            message: "Not enough recent completed matches with score data to produce a responsible prediction.",
            sampleSize: { home: homeForm.length, away: awayForm.length },
            minimumRequired: 3
          }, 200);
        }

        function weightedAverage(values, weights) {
          const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
          return totalWeight ? values.reduce((sum, value, index) => sum + value * weights[index], 0) / totalWeight : null;
        }

        function periodAverages(form, key, preferredVenue) {
          const venueRows = form.filter(item => item.venue === preferredVenue && item[key]);
          const useVenueSplit = venueRows.length >= 3;
          const selected = useVenueSplit ? venueRows : form.filter(item => item[key]);
          const rows = selected.map(item => {
            const matchDate = new Date(String(item.date || "").replace(" ", "T") + "Z");
            const ageDays = Number.isNaN(matchDate.getTime())
              ? 0
              : Math.max(0, (kickoff.getTime() - matchDate.getTime()) / 86400000);
            // A 45-day half-life gives recent performances more influence without discarding older matches.
            const weight = Math.exp(-Math.LN2 * ageDays / 45);
            return { stats: item[key], weight };
          });
          const weights = rows.map(row => row.weight);
          return {
            scored: weightedAverage(rows.map(row => row.stats.scored), weights),
            conceded: weightedAverage(rows.map(row => row.stats.conceded), weights),
            matches: rows.length,
            venueMatches: venueRows.length,
            venueSplitUsed: useVenueSplit
          };
        }
        const hft = periodAverages(homeForm, "ft", "home");
        const aft = periodAverages(awayForm, "ft", "away");
        const hht = periodAverages(homeForm, "ht", "home");
        const aht = periodAverages(awayForm, "ht", "away");

        function expectedGoals(teamAttack, opponentDefence) {
          return Math.max(0.05, Math.min(4.5, (teamAttack + opponentDefence) / 2));
        }
        const ftHome = expectedGoals(hft.scored, aft.conceded);
        const ftAway = expectedGoals(aft.scored, hft.conceded);
        const htReady = hht.scored !== null && aht.scored !== null &&
          hht.conceded !== null && aht.conceded !== null;
        const htHome = htReady ? expectedGoals(hht.scored, aht.conceded) : null;
        const htAway = htReady ? expectedGoals(aht.scored, hht.conceded) : null;
        const sampleSize = { home: homeForm.length, away: awayForm.length };
        const confidence = Math.min(homeForm.length, awayForm.length) >= 6 ? "Moderate" : "Low";
        const result = {
          app: "JUDY AI",
          success: true,
          experimental: true,
          validationStatus: "Not yet backtested or calibrated",
          provider: "Sportmonks",
          fixture: {
            id: target.id,
            name: target.name,
            startingAt: target.starting_at,
            league: target.league && target.league.name,
            homeTeam: homeTeam.name,
            awayTeam: awayTeam.name
          },
          sampleSize,
          venueAnalysis: {
            homeTeamHomeMatches: hft.venueMatches,
            awayTeamAwayMatches: aft.venueMatches,
            homeVenueSplitUsed: hft.venueSplitUsed,
            awayVenueSplitUsed: aft.venueSplitUsed,
            recencyWeighting: "45-day half-life"
          },
          confidence,
          predictions: {
            fullTime: {
              method: "Recency-weighted Poisson model using recent goals, with home/away venue splits when at least 3 venue-specific matches are available",
              expectedGoals: { home: Number(ftHome.toFixed(2)), away: Number(ftAway.toFixed(2)) },
              options: topScoreOptions(ftHome, ftAway)
            },
            halfTime: htReady ? {
              method: "Recency-weighted Poisson model using recent first-half goals, with home/away venue splits when at least 3 venue-specific matches are available",
              expectedGoals: { home: Number(htHome.toFixed(2)), away: Number(htAway.toFixed(2)) },
              options: topScoreOptions(htHome, htAway)
            } : null
          },
          note: "Probabilities are experimental model estimates, not guarantees. This version weights recent matches more heavily and uses venue-specific form when enough data exists. League-wide strength adjustment and historical backtesting are still pending."
        };
        ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" }
        })));
        return reply(result);
      } catch (error) {
        return reply({
          error: error.message || "Could not build fixture analysis",
          providerStatus: error.status || null,
          details: error.details || null
        }, error.status || 502);
      }
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
