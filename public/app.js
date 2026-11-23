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
function teamName(match, side) {
  const obj = side === "home" ? (match.homeTeam || match.home || match.teams?.home) : (match.awayTeam || match.away || match.teams?.away);
  if (typeof obj === "string") return obj;
  return obj?.name || obj?.shortName || (side === "home" ? "Home team" : "Away team");
}
function teamLogo(match, side) {
  const obj = side === "home" ? (match.homeTeam || match.home || match.teams?.home) : (match.awayTeam || match.away || match.teams?.away);
  return obj?.logo || obj?.image || "";
}
function matchTime(match) {
  const raw = match.date || match.startDate || match.kickoff || match.startTime;
  if (!raw) return "Kick-off time TBC";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return String(raw);
  return new Intl.DateTimeFormat("en-KE", {timeZone:"Africa/Nairobi",hour:"2-digit",minute:"2-digit",hour12:true}).format(parsed) + " EAT";
}
function matchStatus(match) {
  const state = match.state || {};
  const status = match.status || {};
  return state.description || status.description || (typeof status === "string" ? status : "") || "Scheduled";
}
function leagueName(match) {
  const league = match.league || match.competition || {};
  return league.name || match.tournament?.name || "Football";
}
function logoMarkup(url, name) {
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
        '<div class="team">' + logoMarkup(teamLogo(match,"home"),home) + '<div class="team-name">' + escapeHtml(home) + '</div></div>' +
        '<div class="versus">VS</div>' +
        '<div class="team">' + logoMarkup(teamLogo(match,"away"),away) + '<div class="team-name">' + escapeHtml(away) + '</div></div>' +
      '</div>' +
      '<div class="fixture-foot"><span>' + escapeHtml(matchTime(match)) + '</span><span>' + escapeHtml(match.country?.name || match.country || "Worldwide") + '</span></div>' +
      '<div class="prediction-label"><span>Half-time score</span><b>ENGINE IN DEVELOPMENT</b></div>' +
      '<div class="prediction-label"><span>Full-time score</span><b>ENGINE IN DEVELOPMENT</b></div>' +
    '</article>';
  }).join("");
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
  showMessage("Checking worldwide fixtures", "JUDY AI is requesting the selected date from Highlightly.", "");
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
      showMessage("Highlightly daily limit reached", "JUDY AI is connected, but Highlightly has exhausted its daily request allowance. Please try again after the provider resets your limit.", "error");
      return;
    }
    if (!response.ok || payload.success === false || payload.error) {
      throw new Error(payload.error || "Unable to load fixtures. Please try again later.");
    }
    const matches = getMatches(payload);
    renderMatches(matches);
    caption.textContent = "Fixtures for " + date + " · East Africa Time";
    showMessage("Fixtures loaded", "Received " + matches.length + " matches from Highlightly.", "success");
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
