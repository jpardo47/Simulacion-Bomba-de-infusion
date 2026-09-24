/* ============================================================================
 * INTERFAZ — paneles, osciloscopio, terminal, alarmas y audio
 * ----------------------------------------------------------------------------
 * Correcciones de la auditoría aplicadas aquí:
 *   P0-3  el caudal ÓPTICO y el caudal REAL son campos distintos y rotulados
 *   P0-4  el "error metrológico" compara ToF contra balanza, no PV contra SP
 *   P2-5  osciloscopio con base de tiempos, disparo, cursores y rejilla rotulada
 *   P2-4  autoescala del canal de caudal
 *   P2-6  búfer circular en el terminal: sin fuga de memoria
 *   P1-13 alarmas con prioridad y patrón acústico normalizado
 *   P1-14 telemetría CSV exportable
 * ========================================================================== */

(function () {
  const CFG = SIM.CFG;
  const U = SIM.util;
  const P = SIM.Plant;
  const FW = SIM.Firmware;
  const HW = SIM.Hardware;

  const $ = id => document.getElementById(id);
  const n = (x, d) => (!isFinite(x) ? '—' : x.toFixed(d));

  /* ======================================================================
   * OSCILOSCOPIO DIGITAL — muestreo real a 1 kHz
   * ==================================================================== */
  const N = CFG.SCOPE.MUESTRAS;
  const buf = {
    d2: new Uint8Array(N).fill(1),
    d3: new Uint8Array(N).fill(1),
    q: new Float32Array(N),
    sp: new Float32Array(N),
    p: new Float32Array(N),
    i: new Float32Array(N),
    w: 0, llenado: 0
  };
  const scope = { msPorDiv: 200, disparo: false, canal: 'caudal', congelado: false };

  function muestrear(qReal, qSp, presMmHg, corr) {
    const k = buf.w;
    buf.d2[k] = FW.st.sensor === "gravimetrico" ? (HW.eventos.some(e => e.hx711) ? 1 : 0) : HW.pines.D2;
    buf.d3[k] = FW.st.sensor === "gravimetrico" ? (FW.st.pwm > 0 ? 1 : 0) : HW.pines.D3;
    buf.q[k] = qReal;
    buf.sp[k] = qSp;
    buf.p[k] = presMmHg;
    buf.i[k] = corr;
    buf.w = (k + 1) % N;
    if (buf.llenado < N) buf.llenado++;
  }

  function leer(arr, idx) { return arr[((idx % N) + N) % N]; }

  function dibujarScope() {
    const cv = $('scope-canvas');
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
    }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const DIVX = 10, DIVY = 6;
    const muestrasVisibles = Math.min(buf.llenado, scope.msPorDiv * DIVX);
    if (muestrasVisibles < 4) return;
    // Índice más antiguo con datos válidos: evita dibujar basura envuelta
    // mientras el búfer circular aún se está llenando.
    const masAntiguo = buf.w - buf.llenado;

    // El disparo alinea el último flanco de bajada de D2, como un
    // osciloscopio real; si no lo encuentra, muestra la ventana más reciente.
    let fin = buf.w - 1;
    if (scope.disparo) {
      for (let k = 2; k < muestrasVisibles - 2; k++) {
        const i = buf.w - 1 - k;
        if (i - 1 < masAntiguo) break;
        if (leer(buf.d2, i) === 0 && leer(buf.d2, i - 1) === 1) {
          fin = Math.min(buf.w - 1, i + Math.floor(muestrasVisibles * 0.82));
          break;
        }
      }
    }
    let ini = fin - muestrasVisibles;
    if (ini < masAntiguo) { ini = masAntiguo; fin = ini + muestrasVisibles; }
    if (fin > buf.w - 1) { fin = buf.w - 1; ini = fin - muestrasVisibles; }

    // Rejilla
    c.strokeStyle = '#e2e8ed'; c.lineWidth = 1;
    for (let i = 0; i <= DIVX; i++) {
      const x = i * w / DIVX;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    }
    for (let i = 0; i <= DIVY; i++) {
      const y = i * h / DIVY;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }

    const px = k => ((k - ini) / muestrasVisibles) * w;

    function trazaDigital(arr, yTop, yBot, color) {
      c.strokeStyle = color; c.lineWidth = 1.8;
      c.beginPath();
      let primero = true;
      for (let k = ini; k <= fin; k++) {
        const v = leer(arr, k);
        const y = v ? yTop : yBot;
        const x = px(k);
        if (primero) { c.moveTo(x, y); primero = false; }
        else {
          const vPrev = leer(arr, k - 1);
          if (vPrev !== v) c.lineTo(x, vPrev ? yTop : yBot);
          c.lineTo(x, y);
        }
      }
      c.stroke();
    }

    // Canales digitales D2 y D3
    trazaDigital(buf.d2, h * 0.08, h * 0.22, '#176b8c');
    trazaDigital(buf.d3, h * 0.28, h * 0.42, '#7351a0');

    // Canal analógico seleccionable con autoescala
    let serie, serie2 = null, color = '#237451', color2 = '#99610e', unidad = 'mL/min';
    if (scope.canal === 'caudal') { serie = buf.q; serie2 = buf.sp; }
    else if (scope.canal === 'presion') { serie = buf.p; unidad = 'mmHg'; color = '#91600d'; }
    else { serie = buf.i; unidad = 'A'; color = '#b33838'; }

    let max = 1e-6;
    for (let k = ini; k <= fin; k++) {
      max = Math.max(max, leer(serie, k), serie2 ? leer(serie2, k) : 0);
    }
    const esc = max * 1.25;
    const yBase = h * 0.97, yAlto = h * 0.50;

    function trazaAnalog(arr, col, punteada) {
      c.strokeStyle = col; c.lineWidth = punteada ? 1.4 : 2;
      if (punteada) c.setLineDash([5, 4]); else c.setLineDash([]);
      c.beginPath();
      for (let k = ini; k <= fin; k++) {
        const y = yBase - (leer(arr, k) / esc) * (yBase - yAlto);
        const x = px(k);
        if (k === ini) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
      c.setLineDash([]);
    }
    if (serie2) trazaAnalog(serie2, color2, true);
    trazaAnalog(serie, color, false);

    // Rótulos de base de tiempos y escala
    c.fillStyle = '#64748b';
    c.font = '10px JetBrains Mono, monospace';
    c.textAlign = 'left';
    c.fillText(`${scope.msPorDiv} ms/div`, 6, h - 6);
    c.fillText(FW.st.sensor === "gravimetrico" ? "Muestra" : "D2", 6, h * 0.08 - 3);
    c.fillText(FW.st.sensor === "gravimetrico" ? "Motor" : "D3", 6, h * 0.28 - 3);
    c.textAlign = 'right';
    c.fillText(`${esc.toFixed(esc < 10 ? 2 : 0)} ${unidad} f.e.`, w - 6, h * 0.52);
    if (scope.disparo) {
      c.fillStyle = '#99610e';
      c.fillText('TRIG ↓D2', w - 6, h - 6);
    }
  }

  /* ======================================================================
   * VALIDACIÓN GRAVIMÉTRICA — el patrón es la balanza (auditoría P0-4)
   * ==================================================================== */
  const histMasa = [];
  const VENTANA_S = 30;

  function caudalGravimetricoMlMin() {
    if (histMasa.length < 2) return NaN;
    const a = histMasa[0], b = histMasa[histMasa.length - 1];
    const dt = b.t - a.t;
    if (dt < 5) return NaN;
    const rho = P.st.fluido.rho / 1000;
    return ((b.m - a.m) / rho) / (dt / 60);
  }

  function registrarMasa(t) {
    const ult = histMasa[histMasa.length - 1];
    if (ult && t - ult.t < 0.25) return;
    histMasa.push({ t, m: P.st.masaIndicadaG });
    while (histMasa.length && t - histMasa[0].t > VENTANA_S) histMasa.shift();
  }

  /* ======================================================================
   * TERMINAL SERIAL — búfer circular, modo prosa o CSV
   * ==================================================================== */
  const MAX_LINEAS = 400;
  let modoCsv = false;
  const csvFilas = [];

  function log(txt, tipo) {
    const term = $('serial-output');
    if (!term) return;
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    const el = document.createElement('div');
    el.className = `log-line ${tipo || 'data'}`;
    el.textContent = `[${hh}:${mm}:${ss}.${ms}] ${txt}`;
    term.appendChild(el);
    while (term.childElementCount > MAX_LINEAS) term.removeChild(term.firstChild);
    if ($('chk-autoscroll') && $('chk-autoscroll').checked) term.scrollTop = term.scrollHeight;
  }

  /* ======================================================================
   * AUDIO DE ALARMA — patrones por prioridad (IEC 60601-1-8)
   * ==================================================================== */
  let actx = null;
  function tono(f, dur, tipo, vol) {
    if (FW.audioSilenciado()) return;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = tipo || 'square';
      o.frequency.setValueAtTime(f, actx.currentTime);
      g.gain.setValueAtTime(vol === undefined ? 0.12 : vol, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0008, actx.currentTime + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + dur);
    } catch (_) { }
  }
  function rafaga(nPulsos, f0, sep) {
    for (let i = 0; i < nPulsos; i++) setTimeout(() => tono(f0 + (i % 3) * 60, 0.07), i * sep);
  }
  let ultimaRafaga = 0;
  function gestionarAudioAlarma(tSim) {
    const prio = FW.prioridadMaxima();
    if (!prio) return;
    const periodo = prio === 'alta' ? 5 : 15;
    if (tSim - ultimaRafaga < periodo) return;
    ultimaRafaga = tSim;
    if (prio === 'alta') { rafaga(5, 960, 110); setTimeout(() => rafaga(5, 960, 110), 900); }
    else rafaga(3, 640, 160);
  }

  /* ======================================================================
   * ACTUALIZACIÓN DE LA INTERFAZ
   * ==================================================================== */
  function texto(id, v) { const e = $(id); if (e) e.textContent = v; }
  function clase(id, c) { const e = $(id); if (e) e.className = c; }

  function actualizarUI() {
    const st = P.st, f = FW.st;
    actualizarRecorrido();

    /* --- Franja de medidas: VERDAD vs MEDIDA vs PATRÓN ---------------- */
    texto('m-delta-t', n(f.ventanaPesoS, 1));
    texto('m-vel-tof', f.medidaValida && f.vMedidaMmS > 0 ? n(f.vMedidaMmS, 2) : '—');
    texto('m-q-tof', f.medidaValida && f.qMedidaMlMin > 0 ? n(f.qMedidaMlMin, 3) : '—');
    texto('m-q-real', n(st.caudalSalidaMlS * 60, 3));
    texto('m-masa', st.masaIndicadaG.toFixed(2));

    const qGrav = caudalGravimetricoMlMin();
    texto('m-q-grav', isFinite(qGrav) ? n(qGrav, 3) : '—');

    // Error METROLÓGICO: sensor óptico contra patrón gravimétrico.
    const eMet = $('m-error-met');
    if (eMet) {
      if (f.medidaValida && isFinite(qGrav) && qGrav > 0.001 && f.qMedidaMlMin > 0) {
        const e = Math.abs((f.qMedidaMlMin - qGrav) / qGrav) * 100;
        eMet.textContent = `${n(e, 2)} %`;
        eMet.className = 'val ' + (e <= 5 ? 'text-success' : 'text-danger');
      } else { eMet.textContent = '—'; eMet.className = 'val'; }
    }
    // Error de SEGUIMIENTO: es otra cosa, y va rotulado como tal.
    const eSeg = $('m-error-seg');
    if (eSeg) {
      const spMlMin = f.setpointMlH / 60;
      if ((f.modo === 'INFUNDIENDO' || f.modo === 'KVO') && spMlMin > 0) {
        const e = Math.abs((st.caudalSalidaMlS * 60 - spMlMin) / spMlMin) * 100;
        eSeg.textContent = `${n(e, 2)} %`;
        eSeg.className = 'val ' + (e <= 5 ? 'text-success' : 'text-warn');
      } else { eSeg.textContent = '—'; eSeg.className = 'val'; }
    }

    /* --- Pantalla del equipo ------------------------------------------ */
    texto('oled-rate', n(f.setpointMlH, 1));
    texto('oled-vtbi', `${n(f.vtbiMl, 1)} mL`);
    texto('oled-vi', `${n(f.viMl, 2)} mL`);
    texto('oled-pwm', `${f.pwm} / 255`);
    texto('oled-presion', `${n(P.presionMmHg(), 0)} mmHg`);
    texto('oled-corriente', `${n(st.corriente, 3)} A`);

    const qActual = st.caudalSalidaMlS * 60;
    if (qActual > 0.005) {
      const restanteMl = Math.max(0, f.vtbiMl - f.viMl);
      const min = restanteMl / qActual;
      const hh = Math.floor(min / 60), mm = Math.floor(min % 60), ss = Math.floor((min * 60) % 60);
      texto('oled-tiempo', `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
    } else texto('oled-tiempo', '--:--:--');

    // Periodo real del lazo de control: el dato que explica por qué el
    // tiempo de vuelo es un mal sensor para realimentar (auditoría P0-5).
    texto('oled-lazo', f.periodoLazo_s > 0 ? `${n(f.periodoLazo_s, 1)} s` : '—');

    /* --- Estado y alarmas --------------------------------------------- */
    const prio = FW.prioridadMaxima();
    const activas = Object.keys(f.alarmas).filter(k => f.alarmas[k].activa);
    const banner = $('alarm-banner');
    if (banner) {
      if (activas.length) {
        banner.className = `alarm-banner activa prio-${prio}`;
        banner.innerHTML = activas.map(k =>
          `<span class="alarm-chip prio-${FW.DEF_ALARMAS[k].prio}">${FW.DEF_ALARMAS[k].txt}</span>`).join('');
      } else {
        banner.className = 'alarm-banner';
        banner.innerHTML = '<span class="alarm-chip ok">SIN ALARMAS ACTIVAS</span>';
      }
    }
    texto('pill-modo', f.modo);
    clase('pill-dot-modo', 'pill-dot ' + (
      prio === 'alta' ? 'red' : prio === 'media' ? 'amber' :
        (f.modo === 'INFUNDIENDO' ? 'green' : '')));
    texto('pill-lazo', f.lazoCerrado ? 'CERRADO' : 'ABIERTO');
    texto('pill-audio', FW.audioSilenciado() ? 'EN PAUSA' : 'ACTIVO');
    texto('pill-uso', 'GRAVIMETRÍA');
    const pu = $('pill-uso-wrap');
    if (pu) pu.className = 'status-pill' + (f.modoBanco ? '' : ' sim-warn');

    const pieOled = $('oled-footer');
    if (pieOled) {
      if (activas.length) {
        pieOled.className = 'oled-footer alert';
        pieOled.textContent = '⚠ ' + FW.DEF_ALARMAS[activas[0]].txt +
          (FW.hayCorte() ? ' — BOMBA DETENIDA (FAIL-SAFE)' : '');
      } else {
        pieOled.className = 'oled-footer';
        pieOled.textContent = f.modo === 'INFUNDIENDO'
          ? (f.bolo.activo
            ? `BOLO: ${n(f.bolo.entregadoMl, 2)} / ${n(f.bolo.objetivoMl, 2)} mL`
            : (f.lazoCerrado ? 'INFUSIÓN ACTIVA — LAZO PI SOBRE MEDIDA DE SENSOR' : 'INFUSIÓN ACTIVA — LAZO ABIERTO'))
          : f.modo === 'KVO' ? 'VTBI COMPLETADO — MANTENIENDO VÍA (KVO)'
            : 'EQUIPO EN ESPERA';
      }
    }

    /* --- Física interna ------------------------------------------------ */
    texto('fis-presion', `${n(P.presionMmHg(), 1)} mmHg`);
    texto('fis-almacenado', `${n(P.volumenAlmacenadoMl(), 4)} mL`);
    texto('fis-omega', `${n(st.omega * 9.549, 0)} rpm`);
    texto('fis-corriente', `${n(st.corriente, 3)} A`);
    texto('fis-vmotor', `${n(st.vMotor, 2)} V`);
    texto('fis-vmedia', `${n(st.velocidadMediaMmS, 2)} mm/s`);
    texto('fis-aire', `${n(st.aireEntregadoMl, 3)} mL`);
    texto('fis-fluencia', `${n(CFG.BOMBA.FLUENCIA_POR_HORA * st.horasFuncionamiento * 100, 2)} %`);
    const re = st.velocidadMediaMmS * 1e-3 * st.dRealMm * 1e-3 * st.fluido.rho / st.fluido.mu;
    texto('fis-reynolds', n(re, 1));

    const tr = st.trazadores[0];
    texto('fis-ktrazador', tr ? n(tr.kEfectivo, 3) : '—');
    texto('fis-vtrazador', tr ? `${n(tr.vMmS, 2)} mm/s` : '—');

    /* --- Resolución del actuador: el hallazgo P0-5, en vivo ------------ */
    const pwmActual = f.pwm;
    const qPorLsb = estimarQPorLsb(pwmActual);
    texto('fis-lsb', `${n(qPorLsb * 60, 2)} mL/h`);
    const relLsb = (f.setpointMlH > 0) ? (qPorLsb * 60 / f.setpointMlH * 100) : NaN;
    const elLsb = $('fis-lsb-rel');
    if (elLsb) {
      elLsb.textContent = isFinite(relLsb) ? `${n(relLsb, 1)} %` : '—';
      elLsb.className = 'mini-val ' + (relLsb > 5 ? 'text-danger' : 'text-success');
    }
  }

  function actualizarRecorrido() {
    const st=P.st, f=FW.st;
    texto('flow-clock', n(st.tiempoSim,1)+' s simulados · '+(SIM.velocidadTiempo||1)+'×');
    texto('flow-source', n(HW.pesoDepositoG,2)+' g brutos');
    texto('flow-reservoir', n(st.depositoMl,2)+' mL restantes (modelo)');
    texto('flow-pump', n(st.omega/CFG.BOMBA.RELACION_REDUCTORA*60/(2*Math.PI),2)+' rpm del cabezal');
    texto('flow-speed', n(st.velocidadMediaMmS,2)+' mm/s · rodillo '+(1+Math.floor(st.anguloBomba/(2*Math.PI/3)))+' en ciclo');
    texto('flow-weight', f.medidaValida ? n(f.qMedidaMlMin*60,1)+' mL/h' : 'Reuniendo muestras');
    texto('flow-window', n(f.ventanaPesoS,1)+' / 30 s · Q = −(dm/dt) / ρ');
    texto('flow-mass', n(st.masaIndicadaG,2)+' g');
    texto('flow-delivery', n(st.liquidoEntregadoMl,3)+' mL recogidos · '+n(st.caudalColectorMlS*60,3)+' mL/min');
    let msg=FW.hayCorte()?'Bomba detenida por alarma. Revise la causa antes de rearmar.':
      f.modo==='STOP'?'Circuito lleno y bomba detenida. START activa la aspiración y comienza una ventana de pesaje de 30 s.':
      st.frenteS<P.Path.total?'Cebando: '+n(100*st.frenteS/P.Path.total,1)+' % del recorrido lleno. El depósito pierde masa; el colector aún no recibe líquido.':
      !f.medidaValida?'La bomba mueve líquido. El HX711 reúne 30 s de pesaje antes de realimentar el control; puede observarlo con tiempo 10×.':
      'Medición activa sin burbujas: caudal aspirado calculado con muestras de peso. La balanza de salida verifica la entrega de forma independiente.';
    texto('flow-status',msg);
  }

  /** Resolución de caudal de un escalón de PWM en el punto de trabajo. */
  function estimarQPorLsb(pwm) {
    const M = CFG.MOTOR, B = CFG.BOMBA, L = CFG.L298N, A = CFG.ALIMENTACION;
    function qDe(p) {
      const duty = p / 255;
      const v = Math.max(0, duty * (A.V_NOMINAL - L.V_DROP_BASE));
      const w = (v - M.R * M.T_FRICCION / M.Kt) / M.Ke;
      if (w <= 0) return 0;
      return (w / B.RELACION_REDUCTORA) / (2 * Math.PI) * P.st.mlPorRev;
    }
    return Math.max(0, qDe(pwm + 1) - qDe(pwm));
  }

  /* ======================================================================
   * SUSCRIPCIÓN A EVENTOS DEL FIRMWARE
   * ==================================================================== */
  SIM.bus.on('log', d => log(d.txt, d.tipo));

  SIM.bus.on('medida', d => {
    if (modoCsv) return;
    log(`[ToF] Δt = ${d.deltaT.toFixed(4)} s | V = ${d.vel.toFixed(2)} mm/s | ` +
      `Q = ${d.q.toFixed(3)} mL/min (${d.qMlH.toFixed(1)} mL/h) | ` +
      `periodo de lazo = ${d.periodoLazo.toFixed(1)} s`, 'success');
  });

  SIM.bus.on('aire', d => {
    if (modoCsv) return;
    const sufijo = d.superaUmbral
      ? (d.inhibida ? ' — SUPERA EL UMBRAL, alarma inhibida por estar en modo banco'
        : ' — SUPERA EL UMBRAL')
      : '';
    log(`[AIRE] Burbuja de ${d.volUl.toFixed(1)} µL medida por ancho de pulso ` +
      `(umbral ${CFG.ALARMAS.AIRE_BOLO_UL} µL). Acumulado: ${d.acumuladoMl.toFixed(3)} mL${sufijo}.`,
      d.superaUmbral ? 'warn' : 'data');
  });

  SIM.bus.on('alarma', d => {
    log(`[ALARMA ${d.def.prio.toUpperCase()}] ${d.def.txt} — ${d.activa ? 'ACTIVADA' : 'resuelta'}` +
      (d.activa && d.def.corta ? ' → corte fail-safe: ENA=0, IN1=LOW, IN2=LOW' : ''),
      d.activa ? 'danger' : 'success');
    if (d.activa) ultimaRafaga = -999;
  });

  SIM.bus.on('csv', d => {
    csvFilas.push([d.t, d.setpoint, d.vMedida, d.pwm, d.alarma].join(','));
    if (csvFilas.length > 20000) csvFilas.shift();
    if (modoCsv) log(`${d.t},${d.setpoint},${d.vMedida},${d.pwm},${d.alarma}`, 'data');
  });

  /* ======================================================================
   * CONTROLES
   * ==================================================================== */
  function on(id, ev, fn) { const e = $(id); if (e) e.addEventListener(ev, fn); }

  function conectarControles() {
    on('btn-start', 'click', () => {
      if (FW.hayCorte()) { log('[CMD] START rechazado: hay una alarma activa sin rearmar.', 'danger'); return; }
      FW.start(); tono(660, 0.12, 'sine');
      if (SIM.autoTrazador && FW.st.sensor === 'optico' && !P.st.trazadores.length) {
        P.inyectarTrazador(parseFloat($('inp-trazador-vol').value));
      }
      actualizarUI();
      log('[CMD] START — lazo de regulación activo, PWM por D9 (Timer1).', 'info');
    });
    on('btn-stop', 'click', () => {
      FW.stop(); tono(440, 0.15, 'sine');
      actualizarUI();
      log('[CMD] STOP — analogWrite(D9, 0); IN1=LOW; IN2=LOW.', 'warn');
    });
    on('btn-bolo', 'click', () => {
      const vol = parseFloat($('inp-bolo-vol').value);
      const vel = parseFloat($('inp-bolo-vel').value);
      if (FW.bolo(vol, vel)) {
        $('inp-bolo-vel').value = FW.st.bolo.velocidadMlH;
        tono(880, 0.12, 'sine');
        log(`[CMD] BOLO: dosis limitada a ${vol.toFixed(2)} mL a ${FW.st.bolo.velocidadMlH.toFixed(0)} mL/h. ` +
          `Retorno automático al ritmo base al completarse.`, 'warn');
      } else log('[CMD] BOLO rechazado: compruebe estado, alarmas y dosis/ritmo positivos.', 'danger');
    });
    on('btn-silenciar', 'click', () => {
      FW.reconocerAlarmas();
      log(`[CMD] Audio en pausa ${CFG.ALARMAS.PAUSA_AUDIO_S} s (pausa normalizada, no silencio permanente).`, 'info');
    });
    on('btn-rearmar', 'click', () => {
      FW.rearmar();
      log('[CMD] REARME de alarmas. Verifique que la causa física haya desaparecido.', 'info');
    });

    on('btn-inyectar', 'click', () => {
      const vol = parseFloat($('inp-trazador-vol').value);
      const tr = P.inyectarTrazador(vol);
      if (tr) log(`[TRAZADOR] Inyectado #${tr.id}: ${vol.toFixed(3)} mL → tapón de ` +
        `${tr.longitudMm.toFixed(2)} mm (L/D = ${(tr.longitudMm / P.st.dRealMm).toFixed(2)}), ` +
        `${tr.esTapon ? 'régimen de Taylor' : 'burbuja esférica'}.`, 'info');
      else log('[TRAZADOR] Rechazado: complete el cebado, use un volumen en (0, 1] mL y compruebe el límite de trazadores.', 'warn');
    });
    on('btn-purgar', 'click', () => { P.purgar(); FW.invalidarTransito(); HW.reset(); log('[CMD] PURGA: circuito lleno, trazadores eliminados, presión a cero.', 'info'); });
    on('btn-cebar', 'click', () => { P.vaciarParaCebado(); FW.invalidarTransito(); HW.reset(); log('[CMD] VACIADO para cebado: el menisco avanzará desde el puerto en Y. Método de la guía §1.2.', 'info'); });
    on('btn-tarar', 'click', () => { P.tararBalanza(); FW.resetVolumen(); histMasa.length = 0; log('[CMD] TARA de balanza y puesta a cero del volumen infundido.', 'info'); });

    // Caudal objetivo
    const sl = $('slider-rate'), nu = $('num-rate');
    function setRate(v) {
      FW.setSetpoint(v);
      if (sl) sl.value = FW.st.setpointMlH; if (nu) nu.value = FW.st.setpointMlH;
    }
    on('slider-rate', 'input', e => setRate(parseFloat(e.target.value)));
    on('num-rate', 'change', e => setRate(parseFloat(e.target.value)));

    on('inp-vtbi', 'change', e => { FW.setVtbi(parseFloat(e.target.value)); e.target.value = FW.st.vtbiMl; });

    on('sel-sensor', 'change', e => {
      FW.setSensor(e.target.value);
      log(`[CONFIG] Sensor de flujo: ${e.target.value === 'optico'
        ? 'tiempo de vuelo óptico D2/D3' : e.target.value === 'gravimetrico' ? 'pérdida de peso · HX711' : 'turbina de efecto Hall YF-S401'}.`, 'info');
      if (e.target.value === 'hall') {
        log('[AVISO] El YF-S401 no gira por debajo de ' + CFG.HALL.Q_ARRANQUE_ML_MIN +
          ' mL/min. Todo el régimen de infusión clínica queda fuera de su alcance (guía §1.3).', 'warn');
      }
    });

    on('chk-modo-banco', 'change', e => {
      FW.setModoBanco(e.target.checked);
      if (e.target.checked) {
        log('[MODO] BANCO DE LABORATORIO: el aire se sigue midiendo y registrando, ' +
          'pero no detiene la bomba. Es la única forma de practicar el método de ' +
          'tiempo de vuelo, que necesita inyectar un trazador de aire.', 'info');
      } else {
        log('[MODO] CLÍNICO: alarma de aire en línea ARMADA. Cualquier burbuja mayor de ' +
          CFG.ALARMAS.AIRE_BOLO_UL + ' µL detendrá la bomba. El método del trazador queda ' +
          'inutilizable — y ése es exactamente el aprendizaje.', 'warn');
      }
    });

    on('chk-lazo', 'change', e => {
      FW.setLazoCerrado(e.target.checked);
      log(`[CONFIG] Lazo ${e.target.checked ? 'CERRADO sobre la medida del sensor' :
        'ABIERTO: solo feedforward desde la curva de EEPROM'}.`, 'info');
    });

    on('chk-oclusion', 'change', e => {
      P.setOclusion(e.target.checked);
      if (e.target.checked) {
        log('[FÍSICA] Pinzamiento aplicado aguas abajo. La presión subirá según ' +
          'dP/dt = Q/C; el firmware deberá DETECTARLO por la corriente del motor.', 'warn');
      } else {
        const bolo = P.volumenAlmacenadoMl();
        log(`[FÍSICA] Oclusión liberada. La compliancia del tubo devolverá ` +
          `${bolo.toFixed(4)} mL como BOLO POST-OCLUSIÓN — el fenómeno que IEC 60601-2-24 obliga a ensayar.`, 'danger');
      }
    });

    on('chk-auto-trazador', 'change', e => { SIM.autoTrazador = e.target.checked; });
    on('sel-tiempo-sim', 'change', e => {
      const speed = Number(e.target.value);
      SIM.velocidadTiempo = [1, 5, 10].includes(speed) ? speed : 1;
      actualizarUI();
    });

    // Geometría: nominal (firmware) frente a real (planta)
    on('inp-d-nominal', 'change', e => {
      FW.setDistanciaNominal(parseFloat(e.target.value));
      e.target.value = FW.konst.DISTANCIA_MM;
      log(`[FIRMWARE] DISTANCIA_MM = ${e.target.value} mm (constante programada).`, 'info');
    });
    on('inp-dia-nominal', 'change', e => {
      FW.setDiametroNominal(parseFloat(e.target.value));
      e.target.value = FW.konst.DIAMETRO_MM;
      log(`[FIRMWARE] DIAMETRO_INT_MM = ${e.target.value} mm (constante programada).`, 'info');
    });
    on('inp-dia-real', 'change', e => {
      P.setDiametroReal(parseFloat(e.target.value));
      e.target.value = P.st.dRealMm;
      log(`[FÍSICA] Diámetro REAL del tubo = ${e.target.value} mm. ` +
        `Como Q ∝ D², el error relativo en caudal será el doble del error en diámetro.`, 'warn');
    });
    on('sel-fluido', 'change', e => {
      P.setFluido(e.target.value);
      FW.setDensidad(P.st.fluido.rho / 1000);
      $('inp-densidad').value = FW.st.rhoNominalGml;
      histMasa.length = 0;
      log(`[FÍSICA] Fluido: ${P.st.fluido.nombre} (ρ = ${(P.st.fluido.rho / 1000).toFixed(4)} g/mL).`, 'info');
    });

    on('inp-densidad', 'change', e => { FW.setDensidad(parseFloat(e.target.value)); e.target.value=FW.st.rhoNominalGml; });
    on('inp-kp', 'change', e => { FW.setKp(parseFloat(e.target.value)); e.target.value = CFG.CONTROL.KP; });
    on('inp-ki', 'change', e => { FW.setKi(parseFloat(e.target.value)); e.target.value = CFG.CONTROL.KI; });

    // Osciloscopio
    on('sel-scope-canal', 'change', e => { scope.canal = e.target.value; });
    on('sel-scope-tiempo', 'change', e => { scope.msPorDiv = parseInt(e.target.value, 10); });
    on('chk-scope-trig', 'change', e => { scope.disparo = e.target.checked; });

    // Terminal
    on('btn-limpiar', 'click', () => { const t = $('serial-output'); if (t) t.innerHTML = ''; });
    on('chk-csv', 'change', e => {
      modoCsv = e.target.checked;
      if (modoCsv) log('Timestamp,Setpoint_mm_s,Vxmm_medida,PWM_salida,Estado_Alarma', 'info');
    });
    on('btn-exportar', 'click', () => {
      const cab = 'Timestamp_s,Setpoint_mm_s,Vxmm_medida_mm_s,PWM_salida,Estado_Alarma\n';
      const blob = new Blob([cab + csvFilas.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `telemetria_infusion_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      log(`[CMD] Exportadas ${csvFilas.length} filas de telemetría CSV.`, 'success');
    });

    // Vista 3D
    on('btn-vista-reset', 'click', () => SIM.Scene3D.encuadrar(null));

    // Lista accesible de componentes: el raycasting no es accesible por sí solo.
    const lista = $('lista-componentes');
    if (lista) {
      Object.keys(SIM.Registry).filter(id => !['s1','s2','hall','yport'].includes(id)).forEach(id => {
        const b = document.createElement('button');
        b.className = 'comp-chip';
        b.textContent = SIM.Registry[id].nombre;
        b.setAttribute('aria-label', `Inspeccionar ${SIM.Registry[id].nombre}`);
        b.addEventListener('click', () => { SIM.Scene3D.seleccionar(id); SIM.Scene3D.encuadrar(id); });
        lista.appendChild(b);
      });
    }
  }

  /* ======================================================================
   * API
   * ==================================================================== */
  SIM.UI = {
    init() {
      conectarControles();
      log('[SISTEMA] ATmega328P a 16 MHz. UART a 115200 baudios.', 'info');
      log('[SISTEMA] Timer1 en D9: preescaler /8 → 3.9 kHz (compromiso para el L298N bipolar).', 'info');
      log('[SISTEMA] Celda de carga 500 g + HX711: pesaje a 10 muestras/s; regresión de 30 s. Sin trazadores.', 'info');
      log('[MONTAJE] Entrada sumergida, tubo estanco y flexible. La recuperación de la manguera aspira; los rodillos desplazan el líquido.', 'info');
      log('[MEDIDA] El peso de origen mide aspiración, no garantiza la entrega distal. La balanza de salida es independiente.', 'warn');
      log('[ESPERA] Pulse START para iniciar la infusión.', 'success');
    },
    muestrear, dibujarScope, actualizarUI, registrarMasa, gestionarAudioAlarma, log
  };
})();
