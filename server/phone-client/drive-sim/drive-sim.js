'use strict';
// 주행 시뮬레이션 패널: 차량 목업(/play/vehicle)이 Pleos 내비 보고(navigation.report)를 흉내 내고
// 서버가 만든 경로선을 따라 이동한다. 실제 Pleos 없이 PC 한 대에서 경로·표지판 흐름을 시연할 때 쓴다.
// vehicle.js가 연 window.PLY_VEHICLE_MOCK으로 차량 연결을 함께 쓴다. 이 파일을 빼도 차량 목업은 그대로 동작한다.
(() => {
  const vehicle = window.PLY_VEHICLE_MOCK;
  const anchor = document.getElementById('host-gear')?.closest('section');
  if (!vehicle || !anchor) return;
  const $ = id => document.getElementById(id);

  anchor.insertAdjacentHTML('afterend', `<section class="panel"><h2>주행 시뮬레이션 · Pleos 내비 대체</h2>
<label>경로<select id="sim-route">
<option value="cityhall-seoulstation">서울시청 → 서울역 (약 2km)</option>
<option value="gwanghwamun-gangnam" selected>광화문 → 강남역 (약 10km)</option>
<option value="yeouido-seoulstation">여의도 → 서울역 (약 7km)</option>
<option value="custom">직접 입력</option>
</select></label>
<div id="sim-custom" class="form-row" hidden><label>출발 (위도,경도)<input id="sim-origin" value="37.5663,126.9779"></label><label>도착 (위도,경도)<input id="sim-destination" value="37.5547,126.9707"></label></div>
<div class="form-row"><label>표시 속도<select id="sim-speed"><option value="30">30 km/h</option><option value="50" selected>50 km/h</option><option value="80">80 km/h</option></select></label><label>시연 배속<select id="sim-rate"><option value="1">1배 (실제)</option><option value="3" selected>3배</option><option value="10">10배</option></select></label></div>
<div class="account-actions"><button id="sim-start" class="primary" type="button">안내 시작 · 기어 D</button><button id="sim-redirect" class="quiet" type="button">주행 중 목적지 변경</button><button id="sim-pause" class="quiet" type="button">일시 정지</button><button id="sim-stop" class="quiet" type="button">안내 종료</button></div>
<p id="sim-status" class="subtle" role="status">파티를 만든 뒤 안내를 시작하세요.</p>
<p class="footnote">목업 차량이 Pleos 내비 보고 형식(navigation.report)으로 현재 위치·목적지 좌표를 1초마다 보냄(positionSource=SIMULATED). 서버가 외부 길찾기(OSRM)로 경로선을 만들고 표지판을 배치하며, 목업 차량은 그 경로를 따라 이동함. 배속은 이동 거리에만 적용되고 폰에 보내는 속도는 표시 속도 그대로임.</p>
</section>`);

  const SIM_ROUTES = {
    'cityhall-seoulstation': { name: '서울역', origin: [37.5663, 126.9779], destination: [37.5547, 126.9707] },
    'gwanghwamun-gangnam': { name: '강남역', origin: [37.5759, 126.9768], destination: [37.4979, 127.0276] },
    'yeouido-seoulstation': { name: '서울역', origin: [37.5219, 126.9245], destination: [37.5547, 126.9707] },
  };
  // 주행 중 목적지 변경 후보
  const SIM_DESTINATIONS = [
    { name: '서울역', point: [37.5547, 126.9707] }, { name: '잠실역', point: [37.5133, 127.1001] },
    { name: '여의도', point: [37.5219, 126.9245] }, { name: '강남역', point: [37.4979, 127.0276] },
  ];
  const sim = { state: 'IDLE', routeRevision: 0, position: null, destination: null, name: '', geometry: null, cum: null,
    routeKey: null, alongM: 0, heading: 0, timer: null, lastTick: 0 };

  const R = 6371008.8, toRad = v => v * Math.PI / 180;
  const dist = (a, b) => {
    const dLat = toRad(b.latitude - a.latitude), dLon = toRad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const bearing = (a, b) => {
    const y = Math.sin(toRad(b.longitude - a.longitude)) * Math.cos(toRad(b.latitude));
    const x = Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) - Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(toRad(b.longitude - a.longitude));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };
  function pointAt(m) {
    const g = sim.geometry, c = sim.cum, t0 = Math.max(0, Math.min(m, c.at(-1)));
    let i = 1;
    while (i < c.length - 1 && c[i] < t0) i++;
    const t = (t0 - c[i - 1]) / (c[i] - c[i - 1] || 1);
    return { latitude: g[i - 1].latitude + (g[i].latitude - g[i - 1].latitude) * t, longitude: g[i - 1].longitude + (g[i].longitude - g[i - 1].longitude) * t };
  }
  const speedKmh = () => Number($('sim-speed').value);
  const simSpeedMps = () => sim.state === 'DRIVING' ? speedKmh() / 3.6 : 0;
  function parsePoint(text) {
    const [a, b] = String(text).split(',').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) throw new Error('INVALID_COORDINATE');
    return { latitude: a, longitude: b };
  }
  const simStatus = text => { $('sim-status').textContent = text; };
  const setGear = gear => { $('host-gear').value = gear; vehicle.report(); };

  // vehicle.report에 주행 속도를 붙인다(기어 D일 때만).
  window.PLY_DRIVE_SIM = Object.freeze({ vehicleExtra: () => ({ speedMps: $('host-gear').value === 'D' ? simSpeedMps() : 0 }) });

  function navReport() {
    if (!vehicle.connected() || sim.state === 'IDLE' || !sim.position) return;
    const remaining = sim.cum ? Math.max(0, sim.cum.at(-1) - sim.alongM) : dist(sim.position, sim.destination);
    const base = { source: 'PLEOS_NAVI_HELPER', sdkConnected: true, owned: false, routeRevision: sim.routeRevision, event: 'SIMULATED' };
    const navigation = sim.state === 'ENDED' ? { ...base, status: 'NAVIGATION_ENDED' } : { ...base,
      status: sim.state === 'ARRIVED' ? 'ARRIVED' : 'ROUTE_DRIVE', destination: sim.name,
      destinationLatitude: sim.destination.latitude, destinationLongitude: sim.destination.longitude,
      latitude: sim.position.latitude, longitude: sim.position.longitude, locationAgeMs: 0, positionSource: 'SIMULATED', heading: sim.heading,
      remainingDistanceM: Math.round(remaining), remainingTimeSec: Math.round(remaining / (speedKmh() / 3.6)), speedLimitKmh: speedKmh() >= 80 ? 80 : 50 };
    vehicle.send({ type: 'navigation.report', reportSeq: Date.now(), navigation });
  }

  function simTick() {
    const now = performance.now(), dt = Math.min(3, (now - (sim.lastTick || now)) / 1000);
    sim.lastTick = now;
    const route = vehicle.room()?.journeyRoute;
    // 서버가 새 경로를 만들면 그 경로선의 처음부터 다시 달린다.
    if (route?.status === 'READY' && route.key !== sim.routeKey && ['WAITING_ROUTE', 'DRIVING'].includes(sim.state)) {
      sim.routeKey = route.key; sim.geometry = route.geometry; sim.cum = [0];
      for (let i = 1; i < sim.geometry.length; i++) sim.cum.push(sim.cum[i - 1] + dist(sim.geometry[i - 1], sim.geometry[i]));
      sim.alongM = 0; sim.state = 'DRIVING'; setGear('D');
      vehicle.log('경로 수신 · ' + (route.source === 'STRAIGHT_LINE_FALLBACK' ? '길찾기 실패 → 직선 경로' : route.source) + ' · ' + (route.lengthM / 1000).toFixed(1) + 'km · 표지판 ' + route.signs.length + '개');
    }
    if (sim.state === 'DRIVING' && sim.cum) {
      sim.alongM += speedKmh() / 3.6 * Number($('sim-rate').value) * dt;
      if (sim.alongM >= sim.cum.at(-1)) { sim.alongM = sim.cum.at(-1); sim.state = 'ARRIVED'; vehicle.log('목적지 도착'); vehicle.report(); }
      sim.position = pointAt(sim.alongM);
      const ahead = pointAt(sim.alongM + 20);
      if (dist(sim.position, ahead) > 1) sim.heading = Math.round(bearing(sim.position, ahead));
    }
    navReport();
    const signs = vehicle.room()?.journeyRoute?.signs ?? [];
    const next = signs.filter(s => s.state === 'AHEAD').sort((a, b) => a.aheadM - b.aheadM)[0];
    const ready = signs.filter(s => s.state === 'READY').length;
    const left = sim.cum ? ((sim.cum.at(-1) - sim.alongM) / 1000).toFixed(2) + 'km' : '-';
    simStatus({
      WAITING_ROUTE: '경로 요청 중… (서버가 길찾기 실행)',
      DRIVING: '주행 중 · 남은 ' + left + (ready ? ' · 표지판 근처 ' + ready + '곳' : next ? ' · 다음 표지판 ' + Math.round(next.aheadM) + 'm' : ''),
      PAUSED: '일시 정지', ARRIVED: '목적지 도착', ENDED: '안내 종료',
    }[sim.state] ?? '');
    if (sim.state === 'ENDED') { clearInterval(sim.timer); sim.timer = null; sim.state = 'IDLE'; }
  }

  $('sim-route').addEventListener('change', () => { $('sim-custom').hidden = $('sim-route').value !== 'custom'; });
  $('sim-start').addEventListener('click', () => {
    if (!vehicle.authenticated()) { simStatus('먼저 차량 파티를 만들어 주세요.'); return; }
    if (sim.state === 'PAUSED') { sim.state = 'DRIVING'; sim.lastTick = performance.now(); vehicle.report(); return; }
    try {
      const preset = SIM_ROUTES[$('sim-route').value];
      const origin = preset ? { latitude: preset.origin[0], longitude: preset.origin[1] } : parsePoint($('sim-origin').value);
      sim.destination = preset ? { latitude: preset.destination[0], longitude: preset.destination[1] } : parsePoint($('sim-destination').value);
      sim.name = preset?.name ?? '직접 입력 목적지';
      Object.assign(sim, { position: origin, routeKey: null, geometry: null, cum: null, alongM: 0,
        heading: Math.round(bearing(origin, sim.destination)), state: 'WAITING_ROUTE', lastTick: performance.now() });
      sim.routeRevision++;
      setGear('D'); navReport();
      if (!sim.timer) sim.timer = setInterval(simTick, 1000);
      vehicle.log('안내 시작 · ' + sim.name);
    } catch (e) { vehicle.error(e); }
  });
  // Pleos에서 목적지를 바꾼 것처럼 routeRevision을 올리고 새 목적지를 보고한다. 서버가 경로를 다시 찾는다.
  $('sim-redirect').addEventListener('click', () => {
    if (!['DRIVING', 'WAITING_ROUTE', 'PAUSED'].includes(sim.state)) { simStatus('안내 중일 때 목적지를 바꿀 수 있어요.'); return; }
    const options = SIM_DESTINATIONS.filter(d => d.name !== sim.name), next = options[Math.floor(Math.random() * options.length)];
    sim.destination = { latitude: next.point[0], longitude: next.point[1] }; sim.name = next.name; sim.routeRevision++;
    navReport(); vehicle.log('목적지 변경 → ' + next.name + ' (경로 재탐색)');
  });
  $('sim-pause').addEventListener('click', () => { if (sim.state === 'DRIVING') { sim.state = 'PAUSED'; vehicle.report(); } });
  $('sim-stop').addEventListener('click', () => {
    if (sim.state === 'IDLE') return;
    sim.state = 'ENDED'; setGear('P'); simTick(); vehicle.log('안내 종료');
  });
})();
