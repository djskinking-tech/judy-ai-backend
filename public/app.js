const dateInput = document.getElementById("match-date");
const loadButton = document.getElementById("load-matches");
const messageBox = document.getElementById("message");
const fixturesBox = document.getElementById("fixtures");
const countBox = document.getElementById("match-count");
const caption = document.getElementById("results-caption");

function nairobiToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const values = {};
  parts.forEach(function (part) { values[part.type] = part.value; });
  return values.year + "-" + values.month + "-" + values.day;
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char];
  });
}
function getMatches(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.fixtures)) return payload.fixtures;
  if (Array.isArray(payload.matches)) return payload.matches;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.response)) return payload.response;
  return [];
}
function participant(match, side) {
  const participants = Array.isArray(match.participants) ? match.participants : [];
  return participants.find(function (team) {
    return team.meta && team.meta.location === side;
  }) || null;
}
function teamName(match, side) {
  const obj = side === "home"
    ? (match.homeTeam || match.home || match.teams?.home || participant(match, "home"))
    : (match.awayTeam || match.away || match.teams?.away || participant(match, "away"));
  if (typeof obj === "string") return obj;
  if (obj?.name) return obj.name;
  if (obj?.shortName) return obj.shortName;
  if (match.name && match.name.includes(" vs ")) {
    return match.name.split(" vs ")[side === "home" ? 0 : 1];
  }
  return side === "home" ? "Home team" : "Away team";
}
function teamLogo(match, side) {
  const obj = side === "home"
    ? (match.homeTeam || match.home || match.teams?.home || participant(match, "home"))
    : (match.awayTeam || match.away || match.teams?.away || participant(match, "away"));
  return obj?.logo || obj?.image || obj?.image_path || "";
}
function matchTime(match) {
  const raw = match.date || match.startDate || match.kickoff || match.startTime || match.starting_at;
  if (!raw) return "Kick-off time TBC";
  const parsed = new Date(String(raw).replace(" ", "T") + (String(raw).endsWith("Z") ? "" : "Z"));
  if (Number.isNaN(parsed.getTime())) return String(raw);
  return new Intl.DateTimeFormat("en-KE", {timeZone:"Africa/Nairobi",hour:"2-digit",minute:"2-digit",hour12:true}).format(parsed) + " EAT";
}
function matchStatus(match) {
  const state = match.state || {};
  const status = match.status || {};
  return state.description || state.name || state.short_name || status.description || (typeof status === "string" ? status : "") || "Scheduled";
}
function leagueName(match) {
  const league = match.league || match.competition || {};
  return league.name || match.tournament?.name || "Football";
}
function logoMarkup(url) {
  if (!url) return '<span class="team-placeholder">⚽</span>';
  return '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';
}
function renderMatches(matches) {
  if (!matches.length) {
    fixturesBox.innerHTML = '<div class="empty-state">No fixtures were returned for this date. Try another date.</div>';
    countBox.textContent = "0 MATCHES";
    return;
  }
  countBox.textContent = matches.length + (matches.length === 1 ? " MATCH" : " MATCHES");
  fixturesBox.innerHTML = matches.map(function (match) {
    const home = teamName(match, "home");
    const away = teamName(match, "away");
    const league = leagueName(match);
    const status = matchStatus(match);
    return '<article class="fixture-card">' +
      '<div class="fixture-meta"><span class="fixture-league">' + escapeHtml(league) + '</span><span>' + escapeHtml(status) + '</span></div>' +
      '<div class="fixture-teams">' +
        '<div class="team">' + logoMarkup(teamLogo(match,"home")) + '<div class="team-name">' + escapeHtml(home) + '</div></div>' +
        '<div class="versus">VS</div>' +
        '<div class="team">' + logoMarkup(teamLogo(match,"away")) + '<div class="team-name">' + escapeHtml(away) + '</div></div>' +
      '</div>' +
      '<div class="fixture-foot"><span>' + escapeHtml(matchTime(match)) + '</span><span>' + escapeHtml(match.country?.name || match.country || "Worldwide") + '</span></div>' +
      '<div class="prediction-actions"><button class="prediction-button" data-fixture-id="' + escapeHtml(match.id || match.fixture_id || "") + '">Generate AI predictions</button></div>' +
      '<div class="prediction-results" id="prediction-' + escapeHtml(match.id || match.fixture_id || "") + '"><div class="prediction-label"><span>Half-time score</span><b>Not generated</b></div><div class="prediction-label"><span>Full-time score</span><b>Not generated</b></div></div>' +
    '</article>';
  }).join("");
}
function predictionOptionsMarkup(period, data) {
  if (!data || !Array.isArray(data.options) || !data.options.length) {
    return '<div class="prediction-label"><span>' + period + '</span><b>Insufficient data</b></div>';
  }
  return '<div class="prediction-label"><span>' + period + '</span><b>' +
    data.options.map(function (option) {
      return escapeHtml(option.score) + ' · ' + escapeHtml(option.probability) + '%';
    }).join('  |  ') + '</b></div>';
}
async function generatePrediction(button) {
  const fixtureId = button.dataset.fixtureId;
  const panel = document.getElementById("prediction-" + fixtureId);
  if (!fixtureId || !panel) {
    button.textContent = "Prediction unavailable";
    button.disabled = true;
    return;
  }
  button.disabled = true;
  button.textContent = "Analysing recent form…";
  panel.innerHTML = '<div class="prediction-loading">JUDY AI is analysing recent team results…</div>';
  try {
    const response = await fetch("/api/predictions?fixtureId=" + encodeURIComponent(fixtureId), {
      headers: {"Accept":"application/json"}
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || "Prediction request failed.");
    if (!payload.success) {
      if (payload.status === "insufficient_history") {
        const homeCount = Number(payload.sampleSize && payload.sampleSize.home || 0);
        const awayCount = Number(payload.sampleSize && payload.sampleSize.away || 0);
        const minimum = Number(payload.minimumRequired || 3);
        panel.innerHTML = '<div class="prediction-error">' +
          escapeHtml(payload.message || "Not enough recent match data to make a responsible prediction.") +
          '<br>Home team: ' + escapeHtml(homeCount) + '/' + escapeHtml(minimum) +
          ' matches · Away team: ' + escapeHtml(awayCount) + '/' + escapeHtml(minimum) +
          ' matches required.</div>';
        button.textContent = "Try again";
        return;
      }
      throw new Error(payload.message || "Not enough historical data for a prediction.");
    }
    const saveStatus = payload.tracking && payload.tracking.saveStatus
      ? payload.tracking.saveStatus : "save_status_missing";
    const trackingMessage = saveStatus === "saved"
      ? "✓ Prediction saved before kick-off"
      : saveStatus === "already_saved"
        ? "✓ Original pre-kickoff prediction is already saved"
        : saveStatus === "storage_not_configured"
          ? "⚠ Prediction storage is not configured; this prediction was not saved"
          : saveStatus === "save_failed"
            ? "⚠ Prediction could not be saved. Please try again and check tracking."
            : "⚠ Save confirmation was not received";
    const trackingClass = (saveStatus === "saved" || saveStatus === "already_saved")
      ? "tracking-confirmed" : "tracking-warning";
    panel.innerHTML = predictionOptionsMarkup("Half-time", payload.predictions.halfTime) +
      predictionOptionsMarkup("Full-time", payload.predictions.fullTime) +
      '<p class="prediction-disclaimer">Experimental estimates · ' + escapeHtml(payload.confidence) +
      ' confidence · ' + escapeHtml(payload.sampleSize.home) + ' home / ' + escapeHtml(payload.sampleSize.away) +
      ' away matches analysed. Not guaranteed.</p>' +
      '<p class="prediction-tracking ' + trackingClass + '">' + escapeHtml(trackingMessage) + '</p>';
    button.textContent = "Refresh predictions";
  } catch (error) {
    panel.innerHTML = '<div class="prediction-error">' + escapeHtml(error.message || "Could not generate predictions.") + '</div>';
    button.textContent = "Try again";
  } finally {
    button.disabled = false;
  }
}
function showMessage(title, detail, type) {
  messageBox.className = "message" + (type ? " " + type : "");
  messageBox.innerHTML = '<span class="message-icon">✦</span><div><strong>' + escapeHtml(title) + '</strong><p>' + escapeHtml(detail) + '</p></div>';
}
async function loadFixtures() {
  const date = dateInput.value;
  if (!date) {
    showMessage("Choose a match date", "Please select a date before loading fixtures.", "error");
    return;
  }
  loadButton.disabled = true;
  loadButton.textContent = "Loading…";
  fixturesBox.innerHTML = '<div class="empty-state">Connecting to JUDY AI data center…</div>';
  countBox.textContent = "LOADING";
  caption.textContent = "Fetching fixtures for " + date + ".";
  showMessage("Checking worldwide fixtures", "JUDY AI is requesting the selected date from Sportmonks.", "");
  try {
    const response = await fetch("/api/matches?date=" + encodeURIComponent(date), {
      method: "GET",
      headers: {"Accept":"application/json"}
    });
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error("The data provider returned an unreadable response."); }

    if (response.status === 429 || payload.providerStatus === 429) {
      fixturesBox.innerHTML = "";
      countBox.textContent = "UNAVAILABLE";
      caption.textContent = "Fixture data is temporarily unavailable.";
      showMessage("Sportmonks request limit reached", "The Sportmonks account has reached its current request allowance. Please check the provider dashboard or try again later.", "error");
      return;
    }
    if (!response.ok || payload.success === false || payload.error) {
      const detail = payload.details && payload.details.message ? ": " + payload.details.message : "";
      throw new Error((payload.error || "Unable to load fixtures. Please try again later.") + detail);
    }
    const matches = getMatches(payload);
    renderMatches(matches);
    caption.textContent = "Fixtures for " + date + " · East Africa Time";
    showMessage("Fixtures loaded", "Received " + matches.length + " matches from Sportmonks.", "success");
  } catch (error) {
    fixturesBox.innerHTML = "";
    countBox.textContent = "— MATCHES";
    showMessage("We couldn't load fixtures", error.message || "Please check your connection and try again.", "error");
  } finally {
    loadButton.disabled = false;
    loadButton.innerHTML = 'Load fixtures <span>→</span>';
  }
}
dateInput.value = nairobiToday();
document.getElementById("year").textContent = new Date().getFullYear();
loadButton.addEventListener("click", loadFixtures);
fixturesBox.addEventListener("click", function (event) {
  const button = event.target.closest(".prediction-button");
  if (button) generatePrediction(button);
});
