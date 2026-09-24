/* ============================================================================
 * CAPA DE HARDWARE — convierte física en señales eléctricas, y viceversa
 * ----------------------------------------------------------------------------
 * Es la única frontera entre la planta y el firmware. El firmware ve
 * exclusivamente lo que vería un ATmega328P: flancos en pines con marca de
 * micros(), cuentas de pulsos y lecturas del ADC.
 *
 * Correcciones de la auditoría aplicadas aquí:
 *   P1-2  ancho de haz real de 1 mm (antes 10.9 mm)
 *   P1-1  instante de cruce interpolado dentro del paso → resolución de µs
 *   P1-4  jitter gaussiano en la detección
 *   P1-9  polaridad del flanco configurable, no fijada a ciegas
 *   P1-7  turbina Hall determinista, con umbral de arranque real
 *   P1-8.6 medida de corriente del motor por shunt (detección de oclusión)
 * ========================================================================== */

(function () {
  const CFG = SIM.CFG;
  const U = SIM.util;
  const P = SIM.Plant;

  const SO = CFG.SENSOR_OPTICO;

  const hw = {
    /* Estado lógico de los pines (nivel alto en reposo por pull-up). */
    pines: { D2: 1, D3: 1 },
    /* Cola de flancos entregada al firmware en cada paso. */
    eventos: [],
    /* Fracción de haz obstruida, útil para el 3D y la depuración. */
    obstruccion: { s1: 0, s2: 0 },
    /* Polaridad: true ⇒ el aire en el haz lleva la salida a nivel BAJO. */
    aireEsNivelBajo: true,
    /* Turbina */
    hall: { fase: 0, pulsos: 0, girando: false, rpm: 0, pinAnterior: 1 },
    /* Medida de corriente */
    shuntOhm: 0.22,
    adcCuentas: 0,
    /* Diagnóstico */
    ultimoFlanco: { s1: 0, s2: 0 }
  };

  let fracAnterior = { s1: 0, s2: 0 };
  let acumPeso = 0;
  hw.pesoDepositoG = NaN;
  hw.detecciones = { s1: 0, s2: 0 };
  hw.ultimaDeteccion = { s1: -Infinity, s2: -Infinity };
  let bloqueadoAnterior = { s1: false, s2: false };

  /* ----------------------------------------------------------------------
   * Fracción del haz ocupada por AIRE en la posición `sHaz`.
   * Fuentes de aire: los trazadores (tapones de Taylor) y el tramo aún no
   * cebado por delante del menisco.
   * -------------------------------------------------------------------- */
  function fraccionAire(sHaz) {
    const w = SO.ANCHO_HAZ_MM;
    const hazIni = sHaz - w / 2, hazFin = sHaz + w / 2;
    let frac = 0;

    // Tramo sin cebar: todo lo que está por delante del frente es aire.
    if (P.st.frenteS < hazFin) {
      const lo = Math.max(hazIni, P.st.frenteS);
      frac = Math.max(frac, Math.max(0, hazFin - lo) / w);
    }

    // Trazadores: cada uno ocupa [s − longitud, s].
    const trs = P.st.trazadores;
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      const lo = Math.max(hazIni, tr.s - tr.longitudMm);
      const hi = Math.min(hazFin, tr.s);
      if (hi > lo) frac = Math.max(frac, (hi - lo) / w);
    }
    return U.clamp(frac, 0, 1);
  }

  /* ----------------------------------------------------------------------
   * Detección de un sensor óptico con histéresis y estimación sub-paso del
   * instante de cruce. Devuelve el evento de flanco si lo hubo.
   * -------------------------------------------------------------------- */
  function evaluarSensor(clave, pin, sHaz, dt, tUs) {
    const frac = fraccionAire(sHaz);
    hw.obstruccion[clave] = frac;

    // Histéresis del comparador: umbrales distintos para activar y soltar.
    const umbralOn = SO.HISTERESIS + 0.10;
    const umbralOff = SO.HISTERESIS;
    const antes = bloqueadoAnterior[clave];
    const ahora = antes ? (frac > umbralOff) : (frac > umbralOn);

    let evento = null;
    if (ahora !== antes) {
      const umbral = antes ? umbralOff : umbralOn;
      const f0 = fracAnterior[clave], f1 = frac;
      // Interpolación lineal del instante exacto de cruce dentro del paso.
      let frBloque = (f1 !== f0) ? (umbral - f0) / (f1 - f0) : 0.5;
      frBloque = U.clamp(frBloque, 0, 1);

      const dtUs = dt * 1e6;
      let tEvento = tUs - dtUs + frBloque * dtUs;

      // Jitter de detección: umbral del comparador, refracción, deriva térmica.
      tEvento += U.gauss(SO.JITTER_ABS_US);
      tEvento += U.gauss(SO.JITTER_REL * dtUs);

      const nivel = hw.aireEsNivelBajo ? (ahora ? 0 : 1) : (ahora ? 1 : 0);
      hw.pines[pin] = nivel;
      evento = { pin, nivel, tUs: Math.round(tEvento), obstruido: ahora };
      hw.ultimoFlanco[clave] = tEvento;
      // Contar entrada del trazador, no ambos bordes del mismo pulso.
      if (ahora && P.st.frenteS >= P.Path.total) {
        hw.detecciones[clave]++;
        hw.ultimaDeteccion[clave] = tUs / 1e6;
      }
    }

    bloqueadoAnterior[clave] = ahora;
    fracAnterior[clave] = frac;
    return evento;
  }

  /* ----------------------------------------------------------------------
   * Turbina de efecto Hall YF-S401.
   * Pulsos DETERMINISTAS por acumulador de fase (antes era un proceso de
   * Poisson, que es ruido de disparo inexistente en una turbina real).
   * Y respeta el umbral de arranque: por debajo de ~200 mL/min el rotor no
   * se mueve, exactamente como advierte la guía §1.3.
   * -------------------------------------------------------------------- */
  function evaluarHall(dt, tUs, eventos) {
    const H = CFG.HALL;
    const qMlMin = P.st.caudalSalidaMlS * 60;

    if (qMlMin < H.Q_ARRANQUE_ML_MIN) {
      hw.hall.girando = false;
      hw.hall.rpm = 0;
      return;
    }
    hw.hall.girando = true;

    // K se desvía de su valor nominal cerca del umbral inferior del rango.
    const margen = U.clamp(
      (qMlMin - H.Q_ARRANQUE_ML_MIN) / (H.Q_NOMINAL_MIN_ML_MIN - H.Q_ARRANQUE_ML_MIN), 0, 1);
    const kEfectivo = H.K_PULSOS_POR_ML * (1 - H.NO_LINEALIDAD * (1 - margen));

    const fHz = kEfectivo * (qMlMin / 60);
    hw.hall.rpm = fHz * 60 / 4;    // 4 imanes en el rotor
    hw.hall.fase += fHz * dt;
    while (hw.hall.fase >= 1) {
      hw.hall.fase -= 1;
      hw.hall.pulsos++;
      // Pulso estrecho: flanco de subida y bajada dentro del mismo paso.
      eventos.push({ pin: 'D2', nivel: 1, tUs: Math.round(tUs), hall: true });
    }
  }

  /* ----------------------------------------------------------------------
   * Shunt de medida de corriente en el pin SENSE del L298N.
   * Auditoría P1-8.6: es la forma real de detectar una oclusión.
   * -------------------------------------------------------------------- */
  function leerCorriente() {
    const vShunt = P.st.corriente * hw.shuntOhm;
    // Amplificador de ganancia 20 hacia un ADC de 10 bits con referencia 5 V.
    const vAdc = U.clamp(vShunt * 20 + U.gauss(0.004), 0, 5);
    hw.adcCuentas = Math.round(vAdc / 5 * 1023);
    return hw.adcCuentas;
  }

  /* ----------------------------------------------------------------------
   * Paso de hardware. Devuelve la lista de eventos de flanco del paso.
   * -------------------------------------------------------------------- */
  function step(dt, tUs, modoSensor) {
    const eventos = [];

    if (modoSensor === 'gravimetrico') {
      acumPeso += dt;
      if (acumPeso >= CFG.GRAVIMETRIA.PERIODO_MUESTRA_S) {
        acumPeso = 0;
        const G = CFG.GRAVIMETRIA;
        const bruto = P.masaDepositoG() * G.GANANCIA + G.OFFSET_G + U.gauss(G.RUIDO_G);
        hw.pesoDepositoG = Math.round(bruto / G.RESOLUCION_G) * G.RESOLUCION_G;
        eventos.push({ hx711: true, masaG: hw.pesoDepositoG, tUs });
      }
      hw.hall.girando = false;
      hw.obstruccion.s1 = hw.obstruccion.s2 = 0;
    } else if (modoSensor === 'optico') {
      const e1 = evaluarSensor('s1', 'D2', P.S_SENSOR_1, dt, tUs);
      const e2 = evaluarSensor('s2', 'D3', P.S_SENSOR_2, dt, tUs);
      if (e1) eventos.push(e1);
      if (e2) eventos.push(e2);
      hw.hall.girando = false;
    } else {
      evaluarHall(dt, tUs, eventos);
      hw.obstruccion.s1 = hw.obstruccion.s2 = 0;
    }

    leerCorriente();
    hw.eventos = eventos;
    return eventos;
  }

  function reset() {
    hw.pines.D2 = hw.pines.D3 = 1;
    hw.hall.fase = 0; hw.hall.pulsos = 0;
    fracAnterior = { s1: 0, s2: 0 };
    bloqueadoAnterior = { s1: false, s2: false };
  }

  SIM.Hardware = Object.assign(hw, { step, reset, leerCorriente });
})();
