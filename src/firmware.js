/* ============================================================================
 * FIRMWARE SIMULADO — ATmega328P (Arduino Uno / Nano)
 * ----------------------------------------------------------------------------
 * REGLA ARQUITECTÓNICA INNEGOCIABLE (auditoría P0-1):
 *   Este módulo NO puede leer SIM.Plant. Solo recibe:
 *     · flancos de pin con marca temporal de micros()
 *     · muestras de masa del HX711 (gramos calibrados)
 *     · cuentas del ADC del shunt de corriente
 *   y solo devuelve:
 *     · {enaPwm 0..255, in1, in2}
 *
 *   Todo lo que el firmware "sabe" del tubo son sus CONSTANTES NOMINALES.
 *   Si el tubo real no mide lo que dice la etiqueta, el error aparece — que
 *   es exactamente el objeto de la práctica de metrología.
 *
 * Implementa: PI real con anti-windup y zona muerta, antirrebote en las ISR,
 * timeout de tránsito con corte fail-safe, detección de aire en línea por
 * ancho de pulso, detección de oclusión por corriente de motor, KVO, bolo
 * limitado en dosis y telemetría CSV.
 * ========================================================================== */

(function () {
  const CFG = SIM.CFG;
  const U = SIM.util;
  const C = CFG.CONTROL;

  /* --- Constantes que el firmware cree conocer (editables por el usuario) */
  const konst = {
    DISTANCIA_MM: CFG.SENSOR_OPTICO.DISTANCIA_NOMINAL_MM,
    DIAMETRO_MM: CFG.TUBO.D_NOMINAL_MM,
    get AREA_MM2() { return U.areaMm2(this.DIAMETRO_MM); },
    K_PULSOS_POR_ML: CFG.HALL.K_PULSOS_POR_ML,
    // Curva de calibración PWM→caudal guardada en EEPROM, obtenida por el
    // alumno en una calibración previa. Es una recta ajustada a una planta que
    // NO es una recta, y además está deliberadamente desajustada: si fuese
    // exacta, el término integral sobraría y el lazo no enseñaría nada.
    // Planta real medida: Q[mL/min] ≈ (PWM − 31) · 0.152
    PWM_ARRANQUE: 33,
    PENDIENTE_ML_MIN_POR_PWM: 0.152 * C.FF_DESAJUSTE,
    MIN_INTERVALO_ISR_US: 4000,        // antirrebote óptico (auditoría P0-11)
    // Tránsito más rápido físicamente posible con esta bomba (~1.1 s a caudal
    // máximo). Cualquier Δt por debajo es ruido, no una medida.
    MIN_TRANSITO_US: 200000,
    MAX_INCOHERENTES: 3,               // muestras seguidas antes de alarmar
    FLANCO_AIRE_BAJO: true             // polaridad verificada en calibración
  };

  /* --- Variables "volatile" compartidas con las ISR --------------------- */
  const v = {
    t1_us: 0, t2_us: 0,
    flgS1: false, flgListo: false,
    ultS1_us: 0, ultS2_us: 0,
    // Medida de ancho de pulso en S1 para estimar el volumen de aire.
    s1Inicio_us: 0, anchoPulso_us: 0, anchoPendiente_us: 0,
    pulsosHall: 0
  };

  /* --- Estado del programa ---------------------------------------------- */
  const st = {
    modo: 'STOP',                 // STOP | INFUNDIENDO | KVO | ALARMA
    sensor: 'gravimetrico',       // gravimetrico; optico/hall conservados para ensayos históricos
    masaDepositoG: NaN, ventanaPesoS: 0, ultimaMuestraPeso_us: 0,
    rhoNominalGml: CFG.GRAVIMETRIA.RHO_NOMINAL_G_ML,
    lazoCerrado: true,

    setpointMlH: CFG.INFUSION.RITMO_INICIAL_ML_H,
    vtbiMl: CFG.INFUSION.VTBI_ML,
    viMl: 0,                      // volumen que el equipo CREE haber infundido

    // Medida
    deltaT_s: 0,
    vMedidaMmS: 0,
    qMedidaMlMin: 0,
    medidaValida: false,
    ultimaMedida_us: 0,
    periodoLazo_s: 0,

    // Control
    integrador: 0,
    pwm: 0,
    in1: true, in2: false,
    saturado: false,

    // Bolo con dosis limitada (auditoría P1-12)
    bolo: { activo: false, objetivoMl: 0, entregadoMl: 0, velocidadMlH: 0 },

    // Corriente
    adcCorriente: 0,
    corrienteA: 0,
    corrienteBasalA: 0,
    basalAprendida: false,
    basalContaminada: false,

    // Aire en línea
    aireBoloUl: 0,
    aireAcumuladoMl: 0,
    ventanaAire: [],

    // Alarmas
    alarmas: {},
    audioPausadoHasta_s: 0,

    t_us: 0,
    tInicio_us: 0,
    tArranqueTransito_us: 0,

    // Auditoría P0-7.3: el banco de laboratorio y el uso clínico son
    // INCOMPATIBLES. Inyectar aire es el método de medida de uno y la falta
    // grave del otro. En vez de mezclarlos, se declaran como modos distintos.
    modoBanco: true
  };

  /* --- Definición de alarmas (IEC 60601-1-8: prioridades) ---------------- */
  const DEF_ALARMAS = {
    DEPOSITO_VACIO: { prio: 'alta', txt: 'DEPÓSITO BAJO · RESERVA', corta: true },
    PESO_SIN_DATOS: { prio: 'alta', txt: 'HX711 SIN DATOS', corta: true },
    AIRE_EN_LINEA: { prio: 'alta', txt: 'AIRE EN LÍNEA', corta: true },
    OCLUSION: { prio: 'alta', txt: 'OCLUSIÓN DISTAL', corta: true },
    TIMEOUT_TRAZADOR: { prio: 'alta', txt: 'SIN SEÑAL DE FLUJO', corta: true },
    SENSOR_INCOHERENTE: { prio: 'alta', txt: 'FALLO DE SENSOR', corta: true },
    FUERA_RANGO: { prio: 'media', txt: 'CAUDAL FUERA DE RANGO', corta: false },
    VTBI_COMPLETO: { prio: 'media', txt: 'VTBI COMPLETADO — KVO', corta: false },
    TURBINA_PARADA: { prio: 'media', txt: 'TURBINA POR DEBAJO DE ARRANQUE', corta: false }
  };
  Object.keys(DEF_ALARMAS).forEach(k => {
    st.alarmas[k] = { activa: false, reconocida: false, desde_s: 0 };
  });

  function activarAlarma(k) {
    const a = st.alarmas[k];
    if (!a.activa) {
      a.activa = true; a.reconocida = false; a.desde_s = st.t_us / 1e6;
      SIM.bus.emit('alarma', { clave: k, def: DEF_ALARMAS[k], activa: true });
    }
  }
  function limpiarAlarma(k) {
    const a = st.alarmas[k];
    if (a.activa) {
      a.activa = false; a.reconocida = false;
      SIM.bus.emit('alarma', { clave: k, def: DEF_ALARMAS[k], activa: false });
    }
  }
  function prioridadMaxima() {
    let p = null;
    for (const k in st.alarmas) {
      if (!st.alarmas[k].activa) continue;
      const d = DEF_ALARMAS[k].prio;
      if (d === 'alta') return 'alta';
      if (d === 'media') p = 'media';
    }
    return p;
  }
  function hayCorte() {
    for (const k in st.alarmas) {
      if (st.alarmas[k].activa && DEF_ALARMAS[k].corta) return true;
    }
    return false;
  }

  /* ======================================================================
   * RUTINAS DE SERVICIO DE INTERRUPCIÓN
   * Antirrebote obligatorio: el frente y la cola de un tapón de Taylor
   * producen varias conmutaciones del comparador en pocos cientos de µs.
   * ==================================================================== */
  function ISR_S1(nivel, tUs) {
    const aire = konst.FLANCO_AIRE_BAJO ? (nivel === 0) : (nivel === 1);
    if (aire) {
      if (tUs - v.ultS1_us < konst.MIN_INTERVALO_ISR_US) return;   // rebote
      v.ultS1_us = tUs;
      v.s1Inicio_us = tUs;
      if (!v.flgS1 && !v.flgListo) {
        v.t1_us = tUs;
        v.flgS1 = true;
        st.tArranqueTransito_us = tUs;
      }
    } else if (v.s1Inicio_us) {
      // El ancho del pulso se guarda pendiente: su conversión a volumen
      // necesita la velocidad de ESTE trazador, que no se conoce hasta que
      // complete el tránsito hasta S2.
      v.anchoPulso_us = tUs - v.s1Inicio_us;
      v.anchoPendiente_us = v.anchoPulso_us;
      v.s1Inicio_us = 0;
    }
  }

  function ISR_S2(nivel, tUs) {
    const aire = konst.FLANCO_AIRE_BAJO ? (nivel === 0) : (nivel === 1);
    if (!aire) return;
    if (tUs - v.ultS2_us < konst.MIN_INTERVALO_ISR_US) return;
    v.ultS2_us = tUs;
    if (v.flgS1 && !v.flgListo) {
      v.t2_us = tUs;
      v.flgListo = true;
    }
  }

  function ISR_Hall() { v.pulsosHall++; }

  function atenderEventos(eventos) {
    for (let i = 0; i < eventos.length; i++) {
      const e = eventos[i];
      if (e.hall) { ISR_Hall(); continue; }
      if (e.pin === 'D2') ISR_S1(e.nivel, e.tUs);
      else if (e.pin === 'D3') ISR_S2(e.nivel, e.tUs);
    }
  }

  /* ======================================================================
   * MEDIDA DE CAUDAL
   * ==================================================================== */
  function procesarMedidaOptica() {
    if (!v.flgListo) return false;

    // Copia atómica (noInterrupts / interrupts en el firmware real).
    const t1 = v.t1_us, t2 = v.t2_us;
    v.flgS1 = false; v.flgListo = false;

    // Una sola muestra incoherente NO es un fallo de sensor: puede ser jitter
    // del comparador, o un trazador oscilando sobre el umbral con caudal casi
    // nulo. Se descarta la muestra y solo se alarma si el fallo persiste.
    if (t2 <= t1 || (t2 - t1) < konst.MIN_TRANSITO_US) {
      incoherentes++;
      if (incoherentes >= konst.MAX_INCOHERENTES) activarAlarma('SENSOR_INCOHERENTE');
      return false;
    }
    incoherentes = 0;

    const dt = (t2 - t1) / 1e6;
    // El firmware usa SUS constantes nominales, no las reales.
    const vel = konst.DISTANCIA_MM / dt;
    const q = vel * konst.AREA_MM2 * 60 / 1000;      // mL/min

    st.deltaT_s = dt;
    st.vMedidaMmS = vel;
    st.qMedidaMlMin = q;
    st.medidaValida = true;
    st.periodoLazo_s = st.ultimaMedida_us ? (t2 - st.ultimaMedida_us) / 1e6 : dt;
    st.ultimaMedida_us = t2;
    limpiarAlarma('TIMEOUT_TRAZADOR');
    limpiarAlarma('SENSOR_INCOHERENTE');

    SIM.bus.emit('medida', {
      deltaT: dt, vel, q, qMlH: q * 60,
      periodoLazo: st.periodoLazo_s
    });

    // Ahora sí se conoce la velocidad del trazador: se puede convertir el
    // ancho de pulso guardado en un volumen de aire.
    evaluarAire(vel);
    return true;
  }

  function procesarMedidaHall(dtLoop) {
    const pulsos = v.pulsosHall;
    v.pulsosHall = 0;
    const f = pulsos / dtLoop;
    const qMlMin = (f / konst.K_PULSOS_POR_ML) * 60;
    st.qMedidaMlMin = qMlMin;
    st.vMedidaMmS = qMlMin * 1000 / (konst.AREA_MM2 * 60);
    st.medidaValida = pulsos > 0;
    st.periodoLazo_s = dtLoop;
    if (pulsos === 0 && st.modo === 'INFUNDIENDO') activarAlarma('TURBINA_PARADA');
    else limpiarAlarma('TURBINA_PARADA');
    return st.medidaValida;
  }

  /* ======================================================================
   * DETECCIÓN DE AIRE EN LÍNEA
   * El mismo sensor que mide el caudal sirve para medir el volumen de la
   * burbuja: volumen = ancho_de_pulso × velocidad × área.
   * ==================================================================== */
  function evaluarAire(velTrazador) {
    if (!v.anchoPendiente_us || velTrazador <= 0) return;
    const ancho = v.anchoPendiente_us;
    v.anchoPendiente_us = 0;

    // La longitud medida incluye el ancho del haz, así que el firmware
    // SOBREESTIMA ligeramente el volumen. Es un sesgo real y conservador:
    // más vale una alarma de aire de más que de menos.
    const longitudMm = (ancho / 1e6) * velTrazador;
    const volUl = longitudMm * konst.AREA_MM2;          // mm³ = µL
    st.aireBoloUl = volUl;

    const ahora = st.t_us / 1e6;
    st.ventanaAire.push({ t: ahora, ul: volUl });
    while (st.ventanaAire.length && ahora - st.ventanaAire[0].t > 3600) st.ventanaAire.shift();
    st.aireAcumuladoMl = st.ventanaAire.reduce((a, b) => a + b.ul, 0) / 1000;

    const superaUmbral = volUl > CFG.ALARMAS.AIRE_BOLO_UL ||
      st.aireAcumuladoMl > CFG.ALARMAS.AIRE_ACUMULADO_ML_H;
    // En modo banco el aire se MIDE y se registra, pero no detiene la bomba:
    // de lo contrario la propia práctica de tiempo de vuelo sería imposible.
    if (superaUmbral && !st.modoBanco) activarAlarma('AIRE_EN_LINEA');
    SIM.bus.emit('aire', { volUl, acumuladoMl: st.aireAcumuladoMl, superaUmbral, inhibida: st.modoBanco });
  }

  /* ======================================================================
   * DETECCIÓN DE OCLUSIÓN POR CORRIENTE DE MOTOR
   * El firmware no tiene sensor de presión: infiere el par resistente a
   * partir de la corriente medida en el shunt del pin SENSE.
   * ==================================================================== */
  let contadorOclusion = 0, contadorAbsoluto = 0;
  let incoherentes = 0;
  function evaluarOclusion(adc, dt) {
    // ADC 10 bits, Vref 5 V, ganancia 20, shunt 0.22 Ω.
    st.adcCorriente = adc;
    st.corrienteA = (adc / 1023 * 5) / 20 / 0.22;

    if ((st.modo !== 'INFUNDIENDO' && st.modo !== 'KVO') || st.pwm === 0) {
      contadorOclusion = 0; contadorAbsoluto = 0; return;
    }

    const A = CFG.ALARMAS;

    // ── Criterio ABSOLUTO ───────────────────────────────────────────────
    // Se evalúa SIEMPRE, incluso mientras se aprende la basal. Es la red de
    // seguridad: si la corriente supera el límite duro, hay oclusión, punto.
    if (st.corrienteA > A.I_ABSOLUTA_A) {
      contadorAbsoluto += dt;
      if (contadorAbsoluto > A.T_SOSTENIDO_ABS_S) { activarAlarma('OCLUSION'); return; }
    } else {
      contadorAbsoluto = Math.max(0, contadorAbsoluto - dt);
    }

    const tDesdeArranque = (st.t_us - st.tInicio_us) / 1e6;
    if (!st.basalAprendida) {
      // Los primeros segundos NO sirven de referencia: durante el arranque el
      // motor está cerca del bloqueo y consume mucho más que en régimen.
      if (tDesdeArranque < 2) return;
      const cand = st.corrienteBasalA
        ? U.lpf(st.corrienteBasalA, st.corrienteA, 1.5, dt)
        : st.corrienteA;
      // Una basal implausiblemente alta significa que el fallo YA estaba ahí
      // antes de empezar a medir. Aceptarla dejaría la alarma ciega.
      if (cand > A.I_BASAL_MAX_A) {
        st.basalContaminada = true;
        activarAlarma('OCLUSION');
        return;
      }
      st.basalContaminada = false;
      st.corrienteBasalA = cand;
      if (tDesdeArranque > 6) st.basalAprendida = true;
      return;
    }

    // ── Criterio RELATIVO ───────────────────────────────────────────────
    if (st.corrienteA > st.corrienteBasalA * A.I_OCLUSION_FACTOR) {
      contadorOclusion += dt;
      if (contadorOclusion > A.T_SOSTENIDO_REL_S) activarAlarma('OCLUSION');
    } else {
      contadorOclusion = Math.max(0, contadorOclusion - dt);
      if (contadorOclusion === 0) limpiarAlarma('OCLUSION');
    }
  }

  /* ======================================================================
   * CONTROLADOR PI CON ANTI-WINDUP Y ZONA MUERTA
   * Setpoint y PV en VELOCIDAD (mm/s), como exige la skill pid-controller.
   * ==================================================================== */
  function caudalObjetivoMlMin() {
    if (st.bolo.activo) return st.bolo.velocidadMlH / 60;
    if (st.modo === 'KVO') return CFG.ALARMAS.KVO_ML_H / 60;
    return st.setpointMlH / 60;
  }

  function calcularPWM(hayMedidaNueva, dtMedida) {
    const qSp = caudalObjetivoMlMin();
    const vSp = qSp * 1000 / (konst.AREA_MM2 * 60);     // mm/s

    // Realimentación directa a partir de la curva guardada en EEPROM.
    const ff = konst.PWM_ARRANQUE + qSp / konst.PENDIENTE_ML_MIN_POR_PWM;

    if (st.lazoCerrado && hayMedidaNueva && st.medidaValida) {
      let err = vSp - st.vMedidaMmS;
      if (Math.abs(err) < C.DEADBAND_MM_S) err = 0;      // zona muerta

      const prop = C.KP * err;
      // Anti-windup por clamping condicional: no se integra si la salida ya
      // está saturada y el error empuja hacia más saturación.
      const empujaFuera =
        (st.saturado === 'alta' && err > 0) || (st.saturado === 'baja' && err < 0);
      if (!empujaFuera) {
        // La medida es un promedio de tránsito, no un error instantáneo
        // sostenido durante todo el intervalo sin muestras. Acotar el paso
        // evita saltos de decenas de PWM al recibir medidas muy espaciadas.
        const dtIntegral = Math.min(dtMedida, C.MAX_PASO_INTEGRAL_S);
        st.integrador = U.clamp(st.integrador + C.KI * err * dtIntegral, C.I_MIN, C.I_MAX);
      }
      st.correccion = prop + st.integrador;
    }

    let pwm = ff + (st.correccion || 0);
    st.saturado = false;
    if (pwm > 255) { pwm = 255; st.saturado = 'alta'; }
    if (pwm < 0) { pwm = 0; st.saturado = 'baja'; }

    // Auditoría P0-5: analogWrite recibe un ENTERO de 8 bits. Sin excepción.
    return Math.round(pwm) | 0;
  }

  /* ======================================================================
   * BUCLE PRINCIPAL DEL FIRMWARE
   * ==================================================================== */
  let acumHall = 0;
  let acumTelemetria = 0;
  const muestrasPeso = [];
  let ultimaRegresion = 0;
  function medirPeso(eventos, tUs) {
    let nueva = false;
    for (const e of eventos) {
      if (!e.hx711 || !Number.isFinite(e.masaG)) continue;
      st.masaDepositoG = e.masaG;
      st.ultimaMuestraPeso_us = e.tUs;
      if (e.masaG < CFG.GRAVIMETRIA.TARA_DEPOSITO_G + 5) activarAlarma('DEPOSITO_VACIO');
      if (st.modo !== 'INFUNDIENDO' && st.modo !== 'KVO') continue;
      muestrasPeso.push({ t: e.tUs / 1e6, m: e.masaG });
      const ahora = e.tUs / 1e6;
      while (muestrasPeso.length && ahora - muestrasPeso[0].t > CFG.GRAVIMETRIA.VENTANA_S) muestrasPeso.shift();
      st.ventanaPesoS = ahora - muestrasPeso[0].t;
      if (st.ventanaPesoS < CFG.GRAVIMETRIA.VENTANA_S - 0.2 || ahora - ultimaRegresion < 1) continue;
      const t0 = muestrasPeso[0].t;
      const N = muestrasPeso.length;
      const mt = muestrasPeso.reduce((s,p)=>s+p.t-t0,0)/N;
      const mm = muestrasPeso.reduce((s,p)=>s+p.m,0)/N;
      let xy=0,xx=0;
      for (const p of muestrasPeso) { const x=p.t-t0-mt; xy+=x*(p.m-mm); xx+=x*x; }
      st.qMedidaMlMin = Math.max(0, -xy/xx/st.rhoNominalGml*60);
      st.vMedidaMmS = st.qMedidaMlMin*1000/(konst.AREA_MM2*60);
      st.medidaValida = true;
      st.periodoLazo_s = ultimaRegresion ? ahora-ultimaRegresion : 1;
      ultimaRegresion=ahora; st.ultimaMedida_us=tUs; nueva=true;
    }
    return nueva;
  }

  function loop(dt, tUs, eventos, adcCorriente) {
    st.t_us = tUs;
    atenderEventos(eventos);

    let hayMedida = false;
    if (st.sensor === 'gravimetrico') {
      hayMedida = medirPeso(eventos, tUs);
      if ((st.modo === 'INFUNDIENDO' || st.modo === 'KVO') &&
          tUs - Math.max(st.ultimaMuestraPeso_us, st.tInicio_us) > 2e6) activarAlarma('PESO_SIN_DATOS');
    } else if (st.sensor === 'optico') {
      hayMedida = procesarMedidaOptica();

      // Timeout de tránsito: el trazador entró en S1 y nunca llegó a S2.
      if (v.flgS1 && !v.flgListo && st.modo === 'INFUNDIENDO') {
        const velocidadNominal = caudalObjetivoMlMin() * 1000 / (konst.AREA_MM2 * 60);
        const timeoutS = Math.max(C.TIMEOUT_TRANSITO_MS / 1000,
          C.FACTOR_TIMEOUT_TRANSITO * konst.DISTANCIA_MM / Math.max(velocidadNominal, 0.001));
        if (tUs - st.tArranqueTransito_us > timeoutS * 1e6) {
          activarAlarma('TIMEOUT_TRAZADOR');
          v.flgS1 = false;
        }
      }
    } else {
      acumHall += dt;
      if (acumHall >= C.PERIODO_HALL_MS / 1000) {
        hayMedida = procesarMedidaHall(acumHall);
        acumHall = 0;
      }
    }

    evaluarOclusion(adcCorriente, dt);

    /* --- Integración del volumen infundido (estimación del equipo) ----- */
    if (st.modo === 'INFUNDIENDO' || st.modo === 'KVO') {
      const qEst = (st.medidaValida && st.lazoCerrado)
        ? st.qMedidaMlMin
        : caudalObjetivoMlMin();
      const dV = qEst / 60 * dt;
      st.viMl += dV;
      if (st.bolo.activo) {
        st.bolo.entregadoMl += dV;
        if (st.bolo.entregadoMl >= st.bolo.objetivoMl) {
          st.bolo.activo = false;
          SIM.bus.emit('log', { txt: `[BOLO] Dosis completada: ${st.bolo.objetivoMl.toFixed(2)} mL. Retorno al ritmo base.`, tipo: 'warn' });
        }
      }
      if (st.viMl >= st.vtbiMl && st.modo === 'INFUNDIENDO') {
        st.bolo.activo = false;
        st.modo = 'KVO';
        activarAlarma('VTBI_COMPLETO');
      }
    }

    /* --- Verificación de rango del actuador --------------------------- */
    const qSp = caudalObjetivoMlMin();
    const pwmNecesario = konst.PWM_ARRANQUE + qSp / konst.PENDIENTE_ML_MIN_POR_PWM;
    // Fuera de rango si el actuador satura, o si el PWM necesario cae dentro
    // de la zona muerta: por debajo de ella la bomba sencillamente no gira.
    if ((st.modo === 'INFUNDIENDO') &&
        (pwmNecesario > 255 || pwmNecesario <= konst.PWM_ARRANQUE + 2)) {
      activarAlarma('FUERA_RANGO');
    } else {
      limpiarAlarma('FUERA_RANGO');
    }

    /* --- Salida al puente H, con corte fail-safe ---------------------- */
    if (hayCorte() || (st.modo !== 'INFUNDIENDO' && st.modo !== 'KVO')) {
      // Corte inmediato exigido por la skill biomed-safety: ENA a 0 y ambas
      // entradas de dirección a nivel bajo (puente en alta impedancia).
      st.pwm = 0; st.in1 = false; st.in2 = false;
      st.integrador = 0; st.correccion = 0;
      if (hayCorte() && (st.modo === 'INFUNDIENDO' || st.modo === 'KVO')) {
        st.modo = 'ALARMA'; st.bolo.activo = false;
      }
    } else {
      st.in1 = true; st.in2 = false;
      st.pwm = calcularPWM(hayMedida, st.periodoLazo_s || dt);
    }

    /* --- Telemetría CSV (skill biomed-safety punto 3) ------------------ */
    acumTelemetria += dt;
    if (acumTelemetria >= 0.5) {
      acumTelemetria = 0;
      SIM.bus.emit('csv', {
        t: (tUs / 1e6).toFixed(3),
        setpoint: (caudalObjetivoMlMin() * 1000 / (konst.AREA_MM2 * 60)).toFixed(3),
        vMedida: st.vMedidaMmS.toFixed(3),
        pwm: st.pwm,
        alarma: prioridadMaxima() || 'NINGUNA'
      });
    }

    return { enaPwm: st.pwm, in1: st.in1, in2: st.in2 };
  }

  /* ======================================================================
   * API DE USUARIO (equivale a los botones del panel frontal)
   * ==================================================================== */
  const api = {
    st, konst, DEF_ALARMAS,
    loop,
    prioridadMaxima, hayCorte,

    start() {
      if (hayCorte()) return false;
      api.invalidarTransito();
      st.modo = 'INFUNDIENDO';
      st.tInicio_us = st.t_us;
      st.integrador = 0; st.correccion = 0;
      st.basalAprendida = false; st.corrienteBasalA = 0;
      return true;
    },
    stop() {
      st.modo = 'STOP';
      st.bolo.activo = false;
      st.pwm = 0; st.in1 = false; st.in2 = false;
      api.invalidarTransito();
    },
    invalidarTransito() {
      st.ultimaMuestraPeso_us = 0;
      muestrasPeso.length = 0; ultimaRegresion = 0; st.ventanaPesoS = 0;
      v.flgS1 = false; v.flgListo = false;
      v.s1Inicio_us = 0; v.anchoPendiente_us = 0;
      st.medidaValida = false; st.ultimaMedida_us = 0;
      st.deltaT_s = 0; st.periodoLazo_s = 0;
    },
    /** Bolo limitado en dosis y velocidad (auditoría P1-12). */
    bolo(volumenMl, velocidadMlH) {
      if (st.modo !== 'INFUNDIENDO' && st.modo !== 'KVO') return false;
      if (hayCorte() || !Number.isFinite(volumenMl) || volumenMl <= 0 ||
          !Number.isFinite(velocidadMlH) || velocidadMlH <= 0) return false;
      const vel = Math.min(velocidadMlH, CFG.BOLO.VELOCIDAD_MAX_ML_H);
      st.bolo = {
        activo: true,
        objetivoMl: volumenMl,
        entregadoMl: 0,
        velocidadMlH: vel
      };
      return true;
    },
    cancelarBolo() { st.bolo.activo = false; },
    reconocerAlarmas() {
      let cortaba = hayCorte();
      for (const k in st.alarmas) {
        if (st.alarmas[k].activa) st.alarmas[k].reconocida = true;
      }
      st.audioPausadoHasta_s = st.t_us / 1e6 + CFG.ALARMAS.PAUSA_AUDIO_S;
      return cortaba;
    },
    /** Rearme manual: borra alarmas y queda detenido; no verifica la causa física. */
    rearmar() {
      api.invalidarTransito();
      for (const k in st.alarmas) {
        if (DEF_ALARMAS[k].corta) limpiarAlarma(k);
      }
      contadorOclusion = 0; contadorAbsoluto = 0; incoherentes = 0;
      st.basalAprendida = false; st.corrienteBasalA = 0; st.basalContaminada = false;
      st.tInicio_us = st.t_us;
      if (st.modo === 'ALARMA') st.modo = 'STOP';
    },
    audioSilenciado() { return st.t_us / 1e6 < st.audioPausadoHasta_s; },
    setSetpoint(mlH) {
      if (!Number.isFinite(mlH)) return;
      const nuevo = U.clamp(mlH, CFG.INFUSION.RITMO_MIN_ML_H, CFG.INFUSION.RITMO_MAX_ML_H);
      // Al cambiar el punto de trabajo cambia la corriente de régimen, así que
      // la referencia de oclusión deja de ser válida y hay que reaprenderla.
      if (Math.abs(nuevo - st.setpointMlH) / Math.max(1, st.setpointMlH) > 0.1) {
        st.basalAprendida = false; st.corrienteBasalA = 0;
        st.tInicio_us = st.t_us;
      }
      st.setpointMlH = nuevo;
    },
    setModoBanco(b) {
      st.modoBanco = !!b;
      if (st.modoBanco) limpiarAlarma('AIRE_EN_LINEA');
    },
    setVtbi(ml) { if (Number.isFinite(ml) && ml > 0) st.vtbiMl = Math.max(1, ml); },
    setSensor(s) {
      if (!['optico','hall','gravimetrico'].includes(s)) return;
      api.invalidarTransito();
      st.sensor = s;
      v.flgS1 = false; v.flgListo = false; v.pulsosHall = 0;
      st.medidaValida = false;
      v.s1Inicio_us = 0; v.anchoPendiente_us = 0;
      st.ultimaMedida_us = 0; st.periodoLazo_s = 0;
      st.qMedidaMlMin = 0; st.vMedidaMmS = 0;
      st.deltaT_s = 0; st.integrador = 0; st.correccion = 0;
      acumHall = 0;
      limpiarAlarma('TURBINA_PARADA');
    },
    setLazoCerrado(b) { st.lazoCerrado = !!b; if (!b) { st.integrador = 0; st.correccion = 0; } },
    setDistanciaNominal(mm) { if (Number.isFinite(mm) && mm > 0) konst.DISTANCIA_MM = mm; },
    setDiametroNominal(mm) { if (Number.isFinite(mm) && mm > 0 && mm < CFG.TUBO.D_EXT_MM) konst.DIAMETRO_MM = mm; },
    setKp(k) { if (Number.isFinite(k) && k >= 0) C.KP = k; },
    setDensidad(gml) { if (Number.isFinite(gml) && gml > 0.5 && gml < 2) { st.rhoNominalGml=gml; api.invalidarTransito(); } },
    setKi(k) { if (Number.isFinite(k) && k >= 0) C.KI = k; },
    resetVolumen() {
      st.viMl = 0;
      st.ventanaAire.length = 0;
      st.aireAcumuladoMl = 0;
      limpiarAlarma('VTBI_COMPLETO');
      if (st.modo === 'KVO') st.modo = 'STOP';
    }
  };

  SIM.Firmware = api;
})();
