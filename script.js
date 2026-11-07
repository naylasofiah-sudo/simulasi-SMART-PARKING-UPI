(function(){
  'use strict';

  // ===== KONSTANTA =====
  const CAP = 20, FLOORS = 3;
  const TICK_MS_BASE = 1000;          // 1 tick = 1 menit simulasi pada speed 1×
  const MAX_CONCURRENT_ANIM = 4;      // batasi animasi paralel agar tidak berat
  const RENDER_THROTTLE_MS = 120;     // throttle render gedung

  // Profil permintaan per jam (kendaraan/jam)
  const DEMAND_PER_HOUR = [
    1,1,1,1,1,1, 80, 40,10,10,10,10, 20, 8,8,8, 6, 5,5, 1,1,1,1,1
  ];
  const DEPARTURE_PER_HOUR = [
    2,1,1,1,1,1, 2, 3,3,3,3,3, 55, 6,6,6, 45, 15,30, 2,2,2,2,2
  ];

  const PHASES = [
    { id:'pagi',       label:'Pagi',           from:6*60,  to:7*60 },
    { id:'pagi_akhir', label:'Masuk Sporadis', from:7*60,  to:12*60 },
    { id:'siang',      label:'Siang',          from:12*60, to:13*60 },
    { id:'sore',       label:'Sore',           from:16*60, to:17*60 },
    { id:'petang',     label:'Petang',         from:18*60, to:19*60 },
    { id:'malam',      label:'Malam',          from:19*60, to:24*60 },
    { id:'malam',      label:'Malam',          from:0,     to:6*60 }
  ];

  // ===== STATE =====
  let slots = [Array(CAP).fill(null), Array(CAP).fill(null), Array(CAP).fill(null)];
  let lockedSlots = new Set();
  let activeAnimations = 0;
  let simMinute = 6*60;
  let totalIn = 0, totalOut = 0, totalRejected = 0, processed = 0;
  let targetCount = 200;
  let speed = 2;
  let startHour = 6;
  let running = false, paused = false;
  let simInterval = null;
  let lastRenderTime = 0;
  let lastChartUpdate = 0;

  // ===== DOM =====
  const $ = id => document.getElementById(id);
  const buildingEl = $('building');
  const hudTime = $('hudTime'), hudTime2 = $('hudTime2'), hudPhase = $('hudPhase');
  const hudOccupied = $('hudOccupied'), hudAvailable = $('hudAvailable'),
        hudPercent = $('hudPercent'), hudRejected = $('hudRejected');
  const speedRange = $('speedRange'), speedValue = $('speedValue');
  const startHourSelect = $('startHourSelect');
  const targetCountInput = $('targetCount'), progressValue = $('progressValue');
  const startBtn = $('startBtn'), pauseBtn = $('pauseBtn'),
        resumeBtn = $('resumeBtn'), resetBtn = $('resetBtn');
  const stepEnterBtn = $('stepEnterBtn'), stepExitBtn = $('stepExitBtn'), infoBtn = $('infoBtn');
  const simStatusBadge = $('simStatusBadge');
  const curEnterProb = $('curEnterProb'), curExitProb = $('curExitProb'),
        curEnterRate = $('curEnterRate'), curExitRate = $('curExitRate');
  const logList = $('logList'), logCount = $('logCount');
  const anTotalIn = $('anTotalIn'), anTotalOut = $('anTotalOut'),
        anRejected = $('anRejected'), anProcessed = $('anProcessed'),
        anBusiest = $('anBusiest'), anOverall = $('anOverall'),
        anF1 = $('anF1'), anF2 = $('anF2'), anF3 = $('anF3'), anSimTime = $('anSimTime');
  const modalBg = $('modalBg'), modalClose = $('modalClose');
  const toastEl = $('toast');

  // ===== UTIL =====
  let toastTimer;
  function showToast(msg, type='info') {
    toastEl.textContent = msg;
    toastEl.className = 'toast show ' + (type==='error'?'error':type==='success'?'success':'');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>toastEl.classList.remove('show'), 2000);
  }

  function formatMin(min) {
    const m = ((min % 1440) + 1440) % 1440;
    return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
  }

  function currentHour() {
    return Math.floor((((simMinute % 1440) + 1440) % 1440) / 60);
  }

  function getRates(hour) {
    return {
      enter: DEMAND_PER_HOUR[hour] ?? 5,
      exit:  DEPARTURE_PER_HOUR[hour] ?? 5
    };
  }

  function getPhase() {
    const m = ((simMinute % 1440) + 1440) % 1440;
    for (const p of PHASES) if (m >= p.from && m < p.to) return p;
    return PHASES[0];
  }

  function getProbs() {
    const r = getRates(currentHour());
    return {
      enter: Math.min(0.99, r.enter/60),
      exit:  Math.min(0.99, r.exit/60),
      enterRate: r.enter,
      exitRate: r.exit
    };
  }

  const countOccupied = fi => slots[fi].filter(v=>v!==null).length;
  const totalOccupied = () => slots.reduce((s,f)=>s+f.filter(v=>v!==null).length,0);
  const freeSlots = fi => CAP - countOccupied(fi);

  function recommendFloor() {
    let best = -1, bestFree = -1;
    for (let f=0; f<FLOORS; f++) {
      const free = freeSlots(f);
      if (free > bestFree) { bestFree = free; best = f; }
    }
    return bestFree > 0 ? best : -1;
  }

  // ===== CHART =====
  const chartColors = ['#2d9cdb','#2ecc71','#f1c40f'];
  const barChart = new Chart(document.getElementById('barChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Lantai 1','Lantai 2','Lantai 3'],
      datasets: [{ label:'Kendaraan', data:[0,0,0],
        backgroundColor: chartColors.map(c=>c+'cc'),
        borderColor: chartColors, borderWidth: 2, borderRadius: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, max: 20, ticks: { color:'#6c8da8', stepSize:5 }, grid:{ color:'#1c3d56' } },
        x: { ticks: { color:'#8ab0cf' }, grid:{ display:false } }
      }
    }
  });

  const lineChart = new Chart(document.getElementById('lineChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label:'Lantai 1', data:[], borderColor:'#2d9cdb', backgroundColor:'rgba(45,156,219,0.08)', tension:0.3, fill:true, pointRadius:0, borderWidth:2 },
        { label:'Lantai 2', data:[], borderColor:'#2ecc71', backgroundColor:'rgba(46,204,113,0.08)', tension:0.3, fill:true, pointRadius:0, borderWidth:2 },
        { label:'Lantai 3', data:[], borderColor:'#f1c40f', backgroundColor:'rgba(241,196,15,0.08)', tension:0.3, fill:true, pointRadius:0, borderWidth:2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
      plugins: { legend: { labels: { color:'#8ab0cf', font:{size:9}, boxWidth:10 } } },
      scales: {
        y: { beginAtZero: true, max: 20, ticks:{ color:'#6c8da8', stepSize:5, font:{size:9} }, grid:{ color:'#1c3d56' } },
        x: { ticks:{ color:'#6c8da8', font:{size:8}, maxTicksLimit:8 }, grid:{ display:false } }
      }
    }
  });

  const demandLabels = Array.from({length:24}, (_,h)=>String(h).padStart(2,'0')+':00');
  const demandChart = new Chart(document.getElementById('demandChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: demandLabels,
      datasets: [
        { label:'Masuk (kend/jam)', data: DEMAND_PER_HOUR, borderColor:'#2ecc71', backgroundColor:'rgba(46,204,113,0.15)', tension:0.35, fill:true, pointRadius:2, borderWidth:2 },
        { label:'Keluar (kend/jam)', data: DEPARTURE_PER_HOUR, borderColor:'#f1c40f', backgroundColor:'rgba(241,196,15,0.15)', tension:0.35, fill:true, pointRadius:2, borderWidth:2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
      plugins: { legend: { labels: { color:'#8ab0cf', font:{size:9}, boxWidth:10 } } },
      scales: {
        y: { beginAtZero: true, ticks:{ color:'#6c8da8', font:{size:9} }, grid:{ color:'#1c3d56' } },
        x: { ticks:{ color:'#6c8da8', font:{size:8}, maxTicksLimit:12 }, grid:{ display:false } }
      }
    }
  });

  const markerPlugin = {
    id: 'simMarker',
    afterDraw(chart) {
      const h = currentHour();
      const x = chart.scales.x.getPixelForValue(h);
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = '#e74c3c';
      ctx.lineWidth = 2;
      ctx.setLineDash([4,4]);
      ctx.beginPath();
      ctx.moveTo(x, chart.chartArea.top);
      ctx.lineTo(x, chart.chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };
  demandChart.config.plugins = [markerPlugin];

  // ===== LOG =====
  function addLog(type, msg) {
    if (logList.firstChild && logList.firstChild.textContent.includes('Belum ada')) logList.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'log-item ' + type;
    div.innerHTML = `<span class="log-time">[${formatMin(simMinute)}]</span><span class="log-msg">${msg}</span>`;
    logList.appendChild(div);
    // batasi log agar tidak menumpuk di DOM
    while (logList.children.length > 300) logList.removeChild(logList.firstChild);
    logList.scrollTop = logList.scrollHeight;
    logCount.textContent = logList.children.length + ' entri';
  }

  // ===== RENDER (throttled) =====
  function render(force=false) {
    const now = performance.now();
    if (!force && now - lastRenderTime < RENDER_THROTTLE_MS) return;
    lastRenderTime = now;

    const total = totalOccupied();
    const cap = CAP*FLOORS;
    hudOccupied.textContent = total;
    hudAvailable.textContent = cap-total;
    hudPercent.textContent = Math.round(total/cap*100)+'%';
    hudRejected.textContent = totalRejected;
    hudTime.textContent = formatMin(simMinute);
    hudTime2.textContent = formatMin(simMinute);
    anSimTime.textContent = formatMin(simMinute);

    const phase = getPhase();
    hudPhase.textContent = phase.label;
    document.querySelectorAll('.phase-pill').forEach(el=>{
      el.classList.toggle('active', el.dataset.phase === phase.id);
    });

    const recFloor = recommendFloor();
    buildingEl.querySelectorAll('.floor-row').forEach(e=>e.remove());

    let html = '';
    for (let i=FLOORS-1; i>=0; i--) {
      const occ = countOccupied(i);
      const percent = Math.round(occ/CAP*100);
      let led='led-hijau';
      if (percent>90) led='led-merah';
      else if (percent>70) led='led-kuning';

      let slotHtml='';
      for (let s=0;s<CAP;s++){
        const v = slots[i][s];
        const filled = v!==null;
        const locked = lockedSlots.has(i+'-'+s);
        const icon = filled ? (v==='motor'?'🏍️':'🚗') : '';
        slotHtml += `<div class="slot ${filled?'terisi':'kosong'}" data-floor="${i}" data-slot="${s}" data-filled="${filled}" style="${locked?'pointer-events:none;opacity:.7':''}">${filled?`<span class="veh">${icon}</span>`:''}</div>`;
      }

      html += `
        <div class="floor-row ${led} ${recFloor===i?'recommended':''}" data-floor="${i}" id="floor-${i}">
          <div class="floor-label">
            <div class="led"></div>
            <div class="num">L${i+1}</div>
            <div class="pct">${percent}%</div>
            <div class="rec">${recFloor===i?'★ REKOMENDASI':''}</div>
          </div>
          <div class="floor-area">
            <div class="slots" id="slots-${i}">${slotHtml}</div>
            <div class="lane"></div>
            ${i<FLOORS-1?'<div class="ramp" style="bottom:8px"></div>':''}
          </div>
        </div>`;
    }
    buildingEl.querySelector('.gate-bottom').insertAdjacentHTML('beforebegin', html);

    buildingEl.querySelectorAll('.slot').forEach(slot=>{
      slot.addEventListener('click', ()=>handleSlotClick(slot));
    });

    updateCharts();
    updateAnalysis();
    updateRatesDisplay();
  }

  function updateCharts() {
    const now = performance.now();
    if (now - lastChartUpdate < 200) { // throttle chart 200ms
      return;
    }
    lastChartUpdate = now;

    barChart.data.datasets[0].data = [countOccupied(0), countOccupied(1), countOccupied(2)];
    barChart.update('none');

    lineChart.data.labels.push(formatMin(simMinute));
    lineChart.data.datasets[0].data.push(countOccupied(0));
    lineChart.data.datasets[1].data.push(countOccupied(1));
    lineChart.data.datasets[2].data.push(countOccupied(2));
    if (lineChart.data.labels.length > 60) {
      lineChart.data.labels.shift();
      lineChart.data.datasets.forEach(ds=>ds.data.shift());
    }
    lineChart.update('none');
    demandChart.update('none');
  }

  function updateRatesDisplay() {
    const p = getProbs();
    curEnterProb.textContent = (p.enter*100).toFixed(1) + '% / menit';
    curExitProb.textContent = (p.exit*100).toFixed(1) + '% / menit';
    curEnterRate.textContent = p.enterRate + ' kend/jam';
    curExitRate.textContent = p.exitRate + ' kend/jam';
  }

  function updateAnalysis() {
    anTotalIn.textContent = totalIn;
    anTotalOut.textContent = totalOut;
    anRejected.textContent = totalRejected;
    anProcessed.textContent = processed;

    const occs = [countOccupied(0), countOccupied(1), countOccupied(2)];
    const maxOcc = Math.max(...occs);
    anBusiest.textContent = maxOcc > 0 ? `Lantai ${occs.indexOf(maxOcc)+1} (${maxOcc})` : '—';
    anOverall.textContent = Math.round(totalOccupied()/(CAP*FLOORS)*100) + '%';

    const fmt = (f) => {
      const o = countOccupied(f);
      return Math.round(o/CAP*100) + '% (' + o + '/20)';
    };
    anF1.textContent = fmt(0);
    anF2.textContent = fmt(1);
    anF3.textContent = fmt(2);
  }

  // ===== ANIMASI =====
  function animateEnter(floorIdx, slotIdx, vt) {
    const lockKey = floorIdx+'-'+slotIdx;
    lockedSlots.add(lockKey);

    // kalau terlalu banyak animasi paralel, langsung commit (tanpa animasi)
    if (activeAnimations >= MAX_CONCURRENT_ANIM) {
      commitEnter(floorIdx, slotIdx, vt);
      return;
    }

    const floorRow = document.getElementById(`floor-${floorIdx}`);
    const slotsEl = document.getElementById(`slots-${floorIdx}`);
    if (!floorRow || !slotsEl) { commitEnter(floorIdx, slotIdx, vt); return; }
    const targetSlot = slotsEl.querySelector(`.slot[data-slot="${slotIdx}"]`);
    if (!targetSlot) { commitEnter(floorIdx, slotIdx, vt); return; }

    targetSlot.style.pointerEvents = 'none';
    targetSlot.style.opacity = '0.7';

    const bRect = buildingEl.getBoundingClientRect();
    const fRect = floorRow.getBoundingClientRect();
    const sRect = targetSlot.getBoundingClientRect();

    const icon = vt==='motor'?'🏍️':'🚗';
    const veh = document.createElement('div');
    veh.className = 'vehicle ' + vt;
    veh.textContent = icon;
    veh.style.left = '30px';
    veh.style.top = (bRect.height - 40) + 'px';
    veh.style.opacity = '0';
    buildingEl.appendChild(veh);
    activeAnimations++;

    const targetX = sRect.left - bRect.left + sRect.width/2 - 8;
    const targetY = sRect.top - bRect.top + sRect.height/2 - 8;
    const laneY = fRect.bottom - bRect.top - 12;
    const speedMul = 1 / Math.max(0.5, speed);

    requestAnimationFrame(()=>{
      veh.style.opacity='1';
      veh.style.transition=`left ${0.6*speedMul}s ease-in-out, top ${0.5*speedMul}s ease-in-out`;
      veh.style.left = '40px';
      veh.style.top = laneY + 'px';
    });
    setTimeout(()=>{
      veh.style.transition=`left ${0.7*speedMul}s ease-in-out`;
      veh.style.left = targetX + 'px';
    }, 620*speedMul);
    setTimeout(()=>{
      veh.style.transition=`top ${0.4*speedMul}s ease-out`;
      veh.style.top = targetY + 'px';
    }, 1350*speedMul);
    setTimeout(()=>{
      veh.remove();
      activeAnimations--;
      commitEnter(floorIdx, slotIdx, vt);
    }, 1800*speedMul);
  }

  function commitEnter(floorIdx, slotIdx, vt) {
    lockedSlots.delete(floorIdx+'-'+slotIdx);
    if (slots[floorIdx][slotIdx]===null) {
      slots[floorIdx][slotIdx]=vt;
      totalIn++;
      processed++;
      addLog('in', `⬆ ${vt==='motor'?'Motor':'Mobil'} masuk → L${floorIdx+1} slot ${slotIdx+1}`);
    }
    render();
    updateProgress();
    checkFinished();
  }

  function animateExit(floorIdx, slotIdx, vt) {
    const lockKey = floorIdx+'-'+slotIdx;
    lockedSlots.add(lockKey);

    if (activeAnimations >= MAX_CONCURRENT_ANIM) {
      commitExit(floorIdx, slotIdx);
      return;
    }

    const floorRow = document.getElementById(`floor-${floorIdx}`);
    const slotsEl = document.getElementById(`slots-${floorIdx}`);
    if (!floorRow || !slotsEl) { commitExit(floorIdx, slotIdx); return; }
    const targetSlot = slotsEl.querySelector(`.slot[data-slot="${slotIdx}"]`);
    if (!targetSlot) { commitExit(floorIdx, slotIdx); return; }

    const bRect = buildingEl.getBoundingClientRect();
    const fRect = floorRow.getBoundingClientRect();
    const sRect = targetSlot.getBoundingClientRect();

    const icon = vt==='motor'?'🏍️':'🚗';
    const veh = document.createElement('div');
    veh.className='vehicle ' + vt;
    veh.textContent = icon;
    veh.style.left = (sRect.left-bRect.left+sRect.width/2-8)+'px';
    veh.style.top = (sRect.top-bRect.top+sRect.height/2-8)+'px';
    veh.style.transition='none';
    buildingEl.appendChild(veh);
    activeAnimations++;

    commitExit(floorIdx, slotIdx);

    const laneY = fRect.bottom - bRect.top - 12;
    const speedMul = 1 / Math.max(0.5, speed);

    requestAnimationFrame(()=>{
      veh.style.transition=`top ${0.35*speedMul}s ease-out`;
      veh.style.top = laneY + 'px';
    });
    setTimeout(()=>{
      veh.style.transition=`left ${0.6*speedMul}s ease-in-out, top ${0.5*speedMul}s ease-in-out, opacity 0.3s`;
      veh.style.left = '20px';
      veh.style.top = (bRect.height - 30) + 'px';
      veh.style.opacity='0.2';
    }, 380*speedMul);
    setTimeout(()=>{
      veh.remove();
      activeAnimations--;
      lockedSlots.delete(lockKey);
    }, 1100*speedMul);
  }

  function commitExit(floorIdx, slotIdx) {
    lockedSlots.delete(floorIdx+'-'+slotIdx);
    const vt = slots[floorIdx][slotIdx];
    if (vt!==null) {
      slots[floorIdx][slotIdx] = null;
      totalOut++;
      processed++;
      addLog('out', `⬇ ${vt==='motor'?'Motor':'Mobil'} keluar ← L${floorIdx+1} slot ${slotIdx+1}`);
    }
    render();
    updateProgress();
    checkFinished();
  }

  // ===== OPERASI =====
  function tryEnter() {
    const rec = recommendFloor();
    if (rec === -1) {
      totalRejected++;
      processed++;
      addLog('reject', `✕ Ditolak — semua lantai penuh (${formatMin(simMinute)})`);
      render();
      updateProgress();
      checkFinished();
      return false;
    }
    const slotIdx = slots[rec].indexOf(null);
    if (slotIdx === -1) {
      totalRejected++;
      processed++;
      render(); updateProgress(); checkFinished();
      return false;
    }
    const vt = Math.random()<0.3?'motor':'car';
    animateEnter(rec, slotIdx, vt);
    return true;
  }

  function tryExit() {
    let bestF = -1, bestOcc = 0;
    for (let f=0; f<FLOORS; f++) {
      const o = countOccupied(f);
      if (o > bestOcc) { bestOcc = o; bestF = f; }
    }
    if (bestF === -1) return false;
    let slotIdx = -1;
    for (let s=CAP-1; s>=0; s--) {
      if (slots[bestF][s]!==null && !lockedSlots.has(bestF+'-'+s)) { slotIdx = s; break; }
    }
    if (slotIdx === -1) return false;
    const vt = slots[bestF][slotIdx];
    animateExit(bestF, slotIdx, vt);
    return true;
  }

  function handleSlotClick(slot) {
    const fi = parseInt(slot.dataset.floor,10);
    const si = parseInt(slot.dataset.slot,10);
    if (lockedSlots.has(fi+'-'+si)) return;
    if (slots[fi][si]!==null) {
      const vt = slots[fi][si];
      showToast(`⬇ ${vt==='motor'?'Motor':'Mobil'} keluar L${fi+1}`,'success');
      animateExit(fi, si, vt);
    } else {
      const vt = Math.random()<0.3?'motor':'car';
      showToast(`⬆ ${vt==='motor'?'Motor':'Mobil'} masuk L${fi+1}`,'success');
      animateEnter(fi, si, vt);
    }
  }

  // ===== TICK =====
  function tick() {
    if (!running || paused) return;

    simMinute = (simMinute + 1) % 1440;

    const p = getProbs();
    if (Math.random() < p.enter) tryEnter();
    if (Math.random() < p.exit)  tryExit();

    render();
  }

  // ===== MESIN =====
  function scheduleInterval() {
    if (simInterval) clearInterval(simInterval);
    const ms = Math.round(TICK_MS_BASE / Math.max(0.5, speed));
    simInterval = setInterval(() => {
      if (!running || paused) return;
      if (processed >= targetCount) { stopSim('target'); return; }
      tick();
    }, ms);
  }

  function startSim() {
    if (running && !paused) return;
    running = true;
    paused = false;
    targetCount = Math.max(1, parseInt(targetCountInput.value)||200);
    if (processed >= targetCount) processed = 0;
    simStatusBadge.textContent = 'RUNNING';
    simStatusBadge.style.color = '#2ecc71';
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    resumeBtn.disabled = true;
    scheduleInterval();
    showToast('▶ Simulasi dimulai — jam ' + formatMin(simMinute), 'success');
  }

  function pauseSim() {
    if (!running || paused) return;
    paused = true;
    simStatusBadge.textContent = 'PAUSED';
    simStatusBadge.style.color = '#f1c40f';
    pauseBtn.disabled = true;
    resumeBtn.disabled = false;
  }

  function resumeSim() {
    if (!running || !paused) return;
    paused = false;
    simStatusBadge.textContent = 'RUNNING';
    simStatusBadge.style.color = '#2ecc71';
    pauseBtn.disabled = false;
    resumeBtn.disabled = true;
  }

  function stopSim(reason) {
    running = false;
    paused = false;
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    simStatusBadge.textContent = reason==='target' ? 'SELESAI' : 'IDLE';
    simStatusBadge.style.color = reason==='target' ? '#2d9cdb' : '#6c8da8';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    if (reason==='target') {
      showToast(`✅ Simulasi selesai — ${targetCount} kendaraan diproses`, 'success');
      addLog('info', `★ Simulasi selesai — ${targetCount} kendaraan diproses`);
    }
  }

  function resetAll() {
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    running = false; paused = false;
    slots = [Array(CAP).fill(null), Array(CAP).fill(null), Array(CAP).fill(null)];
    lockedSlots = new Set();
    activeAnimations = 0;
    startHour = parseInt(startHourSelect.value, 10) || 6;
    simMinute = startHour * 60;
    totalIn = 0; totalOut = 0; totalRejected = 0; processed = 0;
    logList.innerHTML = '<div style="color:#6c8da8;font-size:.75rem;padding:8px;text-align:center">Belum ada aktivitas. Klik "Mulai".</div>';
    logCount.textContent = '0 entri';
    lineChart.data.labels = [];
    lineChart.data.datasets.forEach(ds=>ds.data=[]);
    lineChart.update('none');
    simStatusBadge.textContent = 'IDLE';
    simStatusBadge.style.color = '#6c8da8';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    targetCount = Math.max(1, parseInt(targetCountInput.value)||200);
    render(true);
    updateProgress();
    showToast('⟲ Semua data direset — jam ' + formatMin(simMinute), 'info');
  }

  function updateProgress() {
    progressValue.textContent = `${processed} / ${targetCount} kendaraan diproses`;
  }

  function checkFinished() {
    if (processed >= targetCount && running) stopSim('target');
  }

  // ===== EVENTS =====
  startBtn.addEventListener('click', startSim);
  pauseBtn.addEventListener('click', pauseSim);
  resumeBtn.addEventListener('click', resumeSim);
  resetBtn.addEventListener('click', resetAll);

  stepEnterBtn.addEventListener('click', () => {
    if (!running) targetCount = Math.max(1, parseInt(targetCountInput.value)||200);
    tryEnter();
  });
  stepExitBtn.addEventListener('click', () => tryExit());

  speedRange.addEventListener('input', (e) => {
    speed = parseFloat(e.target.value);
    speedValue.textContent = speed.toFixed(1) + '×';
    if (running) scheduleInterval();
  });

  startHourSelect.addEventListener('change', (e) => {
    startHour = parseInt(e.target.value, 10) || 6;
    if (!running) { simMinute = startHour*60; render(true); }
  });

  targetCountInput.addEventListener('change', (e) => {
    targetCount = Math.max(1, Math.min(2000, parseInt(e.target.value)||200));
    e.target.value = targetCount;
    updateProgress();
  });

  infoBtn.addEventListener('click', () => modalBg.classList.add('show'));
  modalClose.addEventListener('click', () => modalBg.classList.remove('show'));
  modalBg.addEventListener('click', (e) => { if (e.target===modalBg) modalBg.classList.remove('show'); });

  document.addEventListener('keydown', e => {
    if (e.target.tagName==='INPUT' || e.target.tagName==='SELECT') return;
    if (e.key==='Enter'){e.preventDefault();startBtn.click();}
    if (e.key==='Backspace'){e.preventDefault();stepExitBtn.click();}
    if (e.key===' '){e.preventDefault(); if(paused) resumeBtn.click(); else if(running) pauseBtn.click();}
    if (e.key==='r'||e.key==='R') resetBtn.click();
  });

  window.addEventListener('beforeunload', () => { if (simInterval) clearInterval(simInterval); });

  // ===== INIT =====
  function init() {
    startHour = parseInt(startHourSelect.value, 10) || 6;
    simMinute = startHour * 60;
    speed = parseFloat(speedRange.value) || 2;
    speedValue.textContent = speed.toFixed(1) + '×';
    targetCount = parseInt(targetCountInput.value) || 200;
    render(true);
    updateProgress();
  }

  init();
})();
