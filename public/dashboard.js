(function () {
  const root = document.getElementById("performance-dashboard");
  if (!root) return;

  const refreshButton = document.getElementById("refresh-performance");
  const status = document.getElementById("performance-status");
  const totals = document.getElementById("performance-totals");
  const modelGrid = document.getElementById("model-performance");
  const records = document.getElementById("prediction-records");

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char];
    });
  }
  function metricLabel(metric) {
    if (!metric || !metric.total) return "Awaiting results";
    return metric.hits + "/" + metric.total + " · " + metric.accuracyPercent + "%";
  }
  function metricCard(title, metric) {
    return '<div class="metric-card"><span>' + escapeHtml(title) + '</span><strong>' +
      escapeHtml(metricLabel(metric)) + '</strong></div>';
  }
  function renderModel(name, data) {
    return '<article class="model-card"><div class="model-title"><h3>' + escapeHtml(name) +
      '</h3><span>TRACKED RESULTS</span></div><div class="metric-grid">' +
      metricCard("FT exact score", data.fullTimeExact) +
      metricCard("FT top two", data.fullTimeTopTwo) +
      metricCard("HT exact score", data.halfTimeExact) +
      metricCard("HT top two", data.halfTimeTopTwo) +
      '</div></article>';
  }

  function accuracyStats(rows, model) {
    const fields=[["HT exact","halfTime","exact"],["HT top two","halfTime","topTwo"],["FT exact","fullTime","exact"],["FT top two","fullTime","topTwo"]];
    return fields.map(function(field){
      const values=rows.map(function(row){const group=row.evaluation&&row.evaluation[model]&&row.evaluation[model][field[1]];return group&&typeof group[field[2]]==="boolean"?group[field[2]]:null;}).filter(function(value){return value!==null;});
      const hits=values.filter(Boolean).length;
      return {label:field[0],hits:hits,total:values.length,pct:values.length?(hits/values.length*100).toFixed(1):"—"};
    });
  }
  function accuracyCards(rows,model){
    return '<div class="accuracy-stats">'+accuracyStats(rows,model).map(function(stat){
      return '<div class="accuracy-stat"><span>'+escapeHtml(stat.label)+'</span><strong>'+(stat.total?stat.hits+'/'+stat.total+' · '+stat.pct+'%':'Awaiting data')+'</strong></div>';
    }).join("")+'</div>';
  }
  function renderAccuracyCentre(items){
    const completed=items.filter(function(item){return item.status==="completed";});
    const overview=document.getElementById("accuracy-overview"), leagueNode=document.getElementById("accuracy-leagues"), monthNode=document.getElementById("accuracy-months");
    if(!overview||!leagueNode||!monthNode)return;
    overview.innerHTML='<div class="accuracy-total"><span>Evaluated matches</span><strong>'+completed.length+'</strong></div>'+
      '<div class="accuracy-models"><article><h4>V1 baseline</h4>'+accuracyCards(completed,"v1")+'</article><article><h4>Current saved model</h4>'+accuracyCards(completed,"v2_1")+'</article></div>';
    function groupsBy(keyFn){
      const groups=new Map();completed.forEach(function(item){const key=keyFn(item);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);});
      return Array.from(groups.entries()).sort(function(a,b){return b[0].localeCompare(a[0]);});
    }
    function draw(node,groups){
      if(!groups.length){node.innerHTML='<p class="accuracy-empty">No completed matches recorded yet.</p>';return;}
      node.innerHTML=groups.map(function(entry){return '<article class="accuracy-group"><div class="accuracy-group-head"><strong>'+escapeHtml(entry[0])+'</strong><span>'+entry[1].length+' completed</span></div><b>V1 baseline</b>'+accuracyCards(entry[1],"v1")+'<b>Current saved model</b>'+accuracyCards(entry[1],"v2_1")+'</article>';}).join("");
    }
    draw(leagueNode,groupsBy(function(item){return item.fixture&&item.fixture.league||"League not recorded";}));
    draw(monthNode,groupsBy(function(item){
      const date=item.completedAt||(item.fixture&&item.fixture.startingAt)||item.capturedAt, parsed=new Date(String(date||"").replace(" ","T"));
      return Number.isNaN(parsed.getTime())?"Date not recorded":new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Nairobi",year:"numeric",month:"long"}).format(parsed);
    }));
  }


  function confidenceCalibration(rows, model, period) {
    const buckets=[
      {label:"Below 10%",min:0,max:10},
      {label:"10–14.9%",min:10,max:15},
      {label:"15–19.9%",min:15,max:20},
      {label:"20% and above",min:20,max:101}
    ];
    const samples=[];
    rows.forEach(function(item){
      const prediction=(model==="v1"?item.baselineV1:item.predictions)||{};
      const block=prediction[period];
      const evaluation=item.evaluation&&item.evaluation[model]&&item.evaluation[model][period];
      const first=block&&Array.isArray(block.options)?block.options[0]:null;
      const probability=first&&Number(first.probability);
      if(!evaluation||typeof evaluation.exact!=="boolean"||!Number.isFinite(probability))return;
      samples.push({probability:probability,hit:evaluation.exact});
    });
    return buckets.map(function(bucket){
      const subset=samples.filter(function(sample){return sample.probability>=bucket.min&&sample.probability<bucket.max;});
      const hits=subset.filter(function(sample){return sample.hit;}).length;
      return {label:bucket.label,total:subset.length,hits:hits,rate:subset.length?(hits/subset.length*100).toFixed(1):"—"};
    }).filter(function(bucket){return bucket.total>0;});
  }
  function renderCalibration(node, rows, model, period) {
    if(!node)return;
    const buckets=confidenceCalibration(rows,model,period);
    if(!buckets.length){node.innerHTML='<p class="confidence-empty">Not enough evaluated probability data yet.</p>';return;}
    node.innerHTML='<div class="confidence-table"><div class="confidence-table-head"><span>Top-score probability</span><span>Exact hits</span><span>Observed rate</span></div>'+
      buckets.map(function(bucket){return '<div class="confidence-table-row"><span>'+escapeHtml(bucket.label)+'</span><strong>'+bucket.hits+'/'+bucket.total+'</strong><b>'+bucket.rate+'%</b></div>';}).join("")+'</div>';
  }
  function renderConfidenceCentre(items){
    const completed=items.filter(function(item){return item.status==="completed";});
    const summary=document.getElementById("confidence-summary");
    if(!summary)return;
    summary.innerHTML='<div class="confidence-summary-card"><span>Completed records available</span><strong>'+completed.length+'</strong></div>'+
      '<p>Observed exact-hit rates are descriptive, not guarantees. Each band needs more matches before it can support a reliable conclusion.</p>';
    renderCalibration(document.getElementById("confidence-current-ht"),completed,"v2_1","halfTime");
    renderCalibration(document.getElementById("confidence-current-ft"),completed,"v2_1","fullTime");
    renderCalibration(document.getElementById("confidence-v1-ht"),completed,"v1","halfTime");
    renderCalibration(document.getElementById("confidence-v1-ft"),completed,"v1","fullTime");
  }

  function hitLabel(label, hit) {
    if (hit === true) return label + ': WON';
    if (hit === false) return label + ': LOST';
    return label + ': PENDING';
  }

  let allRecords = [];
  const dailyReportList = document.getElementById("daily-report-list");
  const dailyReportStatus = document.getElementById("daily-report-status");
  let dailyReportRows = [];
  function reportDateKey(date, offset) {
    const parts = new Intl.DateTimeFormat("en-CA", {timeZone:"Africa/Nairobi",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
    const values = {};
    parts.forEach(function(part){values[part.type]=part.value;});
    const shifted = new Date(Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day)+(offset||0)));
    return shifted.toISOString().slice(0,10);
  }
  function reportOptions(record, period) {
    const block = record.predictions && record.predictions[period];
    return block && Array.isArray(block.options) ? block.options.slice(0,2) : [];
  }
  function reportScore(options) {
    if (!options.length) return "Not available";
    return options.map(function(option,index) {
      const probability = Number(option.probability);
      return (index+1)+". "+String(option.score||"—")+(Number.isFinite(probability)?" · "+probability+"%":"");
    }).join("  |  ");
  }
  function renderDailyReport(items) {
    if (!dailyReportList) return;
    const now = Date.now();
    const today = reportDateKey(new Date(),0), tomorrow = reportDateKey(new Date(),1);
    const dayFilter = document.getElementById("daily-report-date")?.value || "all";
    const query = (document.getElementById("daily-report-search")?.value || "").trim().toLowerCase();
    const upcoming = (Array.isArray(items)?items:[]).map(function(record) {
      const fixture = record.fixture || {};
      const rawKickoff = String(fixture.startingAt || "");
      const kickoff = new Date(rawKickoff.replace(" ","T") + (rawKickoff.endsWith("Z")?"":"Z"));
      const ht = reportOptions(record,"halfTime"), ft = reportOptions(record,"fullTime");
      const probabilities = [ht[0] && Number(ht[0].probability), ft[0] && Number(ft[0].probability)].filter(Number.isFinite);
      const rank = probabilities.length ? probabilities.reduce(function(a,b){return a+b;},0)/probabilities.length : -1;
      const dateKey = Number.isFinite(kickoff.getTime()) ? reportDateKey(kickoff,0) : "";
      return {record:record,fixture:fixture,kickoff:kickoff,ht:ht,ft:ft,rank:rank,dateKey:dateKey};
    }).filter(function(item) {
      if (item.record.status==="completed" || !Number.isFinite(item.kickoff.getTime()) || item.kickoff.getTime()<=now || !item.ht.length || !item.ft.length || item.rank<0) return false;
      if (dayFilter==="today" && item.dateKey!==today) return false;
      if (dayFilter==="tomorrow" && item.dateKey!==tomorrow) return false;
      const searchable=[item.fixture.name,item.fixture.homeTeam,item.fixture.awayTeam,item.fixture.league].filter(Boolean).join(" ").toLowerCase();
      return !query || searchable.includes(query);
    }).sort(function(a,b){return b.rank-a.rank || a.kickoff-b.kickoff;});
    dailyReportRows = upcoming;
    if (dailyReportStatus) dailyReportStatus.textContent = upcoming.length+" upcoming match"+(upcoming.length===1?"":"es")+" with saved HT and FT predictions · ranked by mean top-score probability.";
    if (!upcoming.length) {
      dailyReportList.innerHTML='<div class="daily-report-empty">No upcoming saved predictions match this view yet. JUDY AI will list a match here after its pre-kick-off prediction has been saved.</div>';
      return;
    }
    dailyReportList.innerHTML=upcoming.map(function(item,index) {
      const fixture=item.fixture;
      const name=fixture.name||((fixture.homeTeam||"Home")+" vs "+(fixture.awayTeam||"Away"));
      const kickoff=new Intl.DateTimeFormat("en-KE",{timeZone:"Africa/Nairobi",weekday:"short",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:true}).format(item.kickoff)+" EAT";
      const quality=item.record.confidence||"Not recorded";
      return '<article class="daily-report-card"><div class="daily-report-card-head"><span class="daily-report-rank">#'+(index+1)+'</span><div class="daily-report-match"><strong>'+escapeHtml(name)+'</strong><small>'+escapeHtml(fixture.league||"League not recorded")+' · '+escapeHtml(kickoff)+'</small></div><b class="daily-report-prob">'+item.rank.toFixed(1)+'%<small>mean top score</small></b></div><div class="daily-report-scores"><div><span>HALF-TIME · TOP 2</span><strong>'+escapeHtml(reportScore(item.ht))+'</strong></div><div><span>FULL-TIME · TOP 2</span><strong>'+escapeHtml(reportScore(item.ft))+'</strong></div></div><div class="daily-report-meta"><span>Recorded confidence: '+escapeHtml(quality)+'</span><span>Pre-kick-off saved prediction</span></div></article>';
    }).join("");
  }


  function csvCell(value) {
    let text = String(value == null ? "" : value);
    if (text && "=+-@\t\r".includes(text.charAt(0))) text = "'" + text;
    return '"' + text.replace(/"/g,'""') + '"';
  }
  function downloadDailyReport() {
    if (!dailyReportRows.length) {
      if (dailyReportStatus) dailyReportStatus.textContent = "There are no upcoming predictions in the current report to export.";
      return;
    }
    const headers = ["Rank","Fixture","League","Kick-off (EAT)","HT option 1","HT probability 1 (%)","HT option 2","HT probability 2 (%)","FT option 1","FT probability 1 (%)","FT option 2","FT probability 2 (%)","Recorded confidence"];
    const rows = dailyReportRows.map(function(item,index) {
      const fixture=item.fixture, date=new Intl.DateTimeFormat("en-KE",{timeZone:"Africa/Nairobi",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(item.kickoff);
      const ht=item.ht,ft=item.ft;
      return [index+1,fixture.name||((fixture.homeTeam||"Home")+" vs "+(fixture.awayTeam||"Away")),fixture.league||"",date,
        ht[0]&&ht[0].score,ht[0]&&ht[0].probability,ht[1]&&ht[1].score,ht[1]&&ht[1].probability,
        ft[0]&&ft[0].score,ft[0]&&ft[0].probability,ft[1]&&ft[1].score,ft[1]&&ft[1].probability,item.record.confidence||""]
        .map(csvCell).join(",");
    });
    const csv = "\uFEFF" + [headers.map(csvCell).join(",")].concat(rows).join("\r\n");
    const blob = new Blob([csv],{type:"text/csv;charset=utf-8;"});
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href=url; link.download="judy-ai-prediction-report-"+reportDateKey(new Date(),0)+".csv";
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    if (dailyReportStatus) dailyReportStatus.textContent = "Exported "+dailyReportRows.length+" upcoming predictions to CSV.";
  }

  function renderRecords(items) {
    allRecords = Array.isArray(items) ? items : [];
    const query = (document.getElementById("performance-search")?.value || "").trim().toLowerCase();
    const filtered = allRecords.filter(function (item) {
      const fixture = item.fixture || {};
      const text = [fixture.name, fixture.homeTeam, fixture.awayTeam, fixture.league, item.fixtureId]
        .filter(Boolean).join(" ").toLowerCase();
      return !query || text.includes(query);
    });
    if (!filtered.length) {
      records.innerHTML = '<div class="dashboard-empty">' +
        (allRecords.length ? 'No prediction records match that search.' : 'No predictions have been saved yet. Generate a prediction for an upcoming match to start tracking.') +
        '</div>';
      return;
    }
    records.innerHTML = filtered.map(function (item) {
      const fixture = item.fixture || {};
      const name = fixture.name || ((fixture.homeTeam || "Home") + " vs " + (fixture.awayTeam || "Away"));
      const actual = item.actual || {};
      const evaluation = item.evaluation || {};
      const predictions = item.predictions || {};
      const baseline = item.baselineV1 || {};
      function scoreText(source, period) {
        const options = source && source[period] && Array.isArray(source[period].options) ? source[period].options : [];
        return options.length ? options.map(function (option) {
          return String(option.score || "—") + (option.probability != null ? " (" + option.probability + "%)" : "");
        }).join(" · ") : "Not available";
      }
      function hitText(model, period) {
        const result = evaluation[model] && evaluation[model][period];
        if (!result || result.topTwo == null) return "Awaiting result";
        return result.topTwo ? "TOP TWO HIT" : "MISSED TOP TWO";
      }
      function modelPanel(label, modelKey, source) {
        const isHit = function (period) {
          const result = evaluation[modelKey] && evaluation[modelKey][period];
          return result && result.topTwo === true ? "hit" : result && result.topTwo === false ? "miss" : "waiting";
        };
        return '<div class="record-model"><strong>' + escapeHtml(label) + '</strong>' +
          '<div><span>HT prediction</span><b>' + escapeHtml(scoreText(source, "halfTime")) + '</b><small class="' + isHit("halfTime") + '">' + escapeHtml(hitText(modelKey, "halfTime")) + '</small></div>' +
          '<div><span>FT prediction</span><b>' + escapeHtml(scoreText(source, "fullTime")) + '</b><small class="' + isHit("fullTime") + '">' + escapeHtml(hitText(modelKey, "fullTime")) + '</small></div></div>';
      }
      const isCompleted = item.status === "completed";
      return '<article class="record-row record-comparison"><div class="record-match-head"><div><strong>' + escapeHtml(name) +
        '</strong><span>' + escapeHtml(fixture.league || "League TBC") + ' · ' + escapeHtml(fixture.startingAt || "Kick-off TBC") +
        '</span></div><span class="record-status ' + (isCompleted ? "is-complete" : "") + '">' + (isCompleted ? "RESULT RECORDED" : "PENDING") + '</span></div>' +
        '<div class="record-model-grid">' + modelPanel("V1 baseline", "v1", baseline) +
        modelPanel(item.experimental ? "Experimental model · V2.2" : "V2.1 model", "v2_1", predictions) + '</div>' +
        '<div class="record-actual"><span>ACTUAL RESULT</span><strong>HT ' + escapeHtml(actual.halfTime || "—") +
        ' · FT ' + escapeHtml(actual.fullTime || "—") + '</strong></div></article>';
    }).join("");
  }
  async function loadPerformance() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";
    status.textContent = "Loading saved predictions and measured results…";
    try {
      const response = await fetch("/api/tracking", {headers: {"Accept":"application/json"}});
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || "Could not load performance data.");
      const pending = Number(payload.pendingPredictions || 0);
      const completed = Number(payload.completedPredictions || 0);
      totals.innerHTML = '<div class="total-card"><span>Total saved</span><strong>' +
        Number(payload.totalPredictions || 0) + '</strong></div><div class="total-card"><span>Awaiting results</span><strong>' +
        pending + '</strong></div><div class="total-card"><span>Completed</span><strong>' + completed + '</strong></div>';
      const metrics = payload.metrics || {};
      modelGrid.innerHTML = renderModel("V1 baseline", metrics.v1 || {}) +
        renderModel("V2.1 experimental", metrics.v2_1 || {});
      renderRecords(Array.isArray(payload.records) ? payload.records : []);
      renderAccuracyCentre(Array.isArray(payload.records) ? payload.records : []);
      renderConfidenceCentre(Array.isArray(payload.records) ? payload.records : []);
      renderDailyReport(Array.isArray(payload.records) ? payload.records : []);
      status.textContent = "Updated " + new Intl.DateTimeFormat("en-KE", {
        timeZone:"Africa/Nairobi", hour:"2-digit", minute:"2-digit", hour12:true
      }).format(new Date()) + " EAT · " + completed + " completed, " + pending + " pending.";
    } catch (error) {
      status.textContent = error.message || "Performance data is temporarily unavailable.";
      totals.innerHTML = "";
      modelGrid.innerHTML = "";
      records.innerHTML = '<div class="dashboard-empty">Could not load tracking data. Please refresh and try again.</div>';
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh data";
    }
  }
  refreshButton.addEventListener("click", loadPerformance);
  const dailyDate=document.getElementById("daily-report-date"), dailySearch=document.getElementById("daily-report-search");
  if(dailyDate) dailyDate.addEventListener("change",function(){renderDailyReport(allRecords);});
  if(dailySearch) dailySearch.addEventListener("input",function(){renderDailyReport(allRecords);});
  const downloadDaily=document.getElementById("download-daily-report");
  if(downloadDaily) downloadDaily.addEventListener("click",downloadDailyReport);
  const printDaily=document.getElementById("print-daily-report");
  if(printDaily) printDaily.addEventListener("click",function(){
    if(!dailyReportRows.length){if(dailyReportStatus)dailyReportStatus.textContent="There are no upcoming predictions in the current report to print.";return;}
    document.body.classList.add("print-daily-report");
    window.print();
  });
  window.addEventListener("afterprint",function(){document.body.classList.remove("print-daily-report");});
  const dailyRefresh=document.getElementById("refresh-daily-report");
  if(dailyRefresh) dailyRefresh.addEventListener("click",loadPerformance);
  const performanceSearch = document.getElementById("performance-search");
  if (performanceSearch) performanceSearch.addEventListener("input", function () { renderRecords(allRecords); });
  loadPerformance();
})();