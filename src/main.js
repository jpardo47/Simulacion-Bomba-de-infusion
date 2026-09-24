/* ============================================================================
 * ORQUESTACIÓN — bucle de paso fijo
 * ----------------------------------------------------------------------------
 * Auditoría P1-3: la física NO puede ir acoplada al frame rate. Se integra a
 * 1 kHz con un acumulador; el dibujo va a la cadencia que dé el navegador.
 *
 * Orden de cada paso (introduce 1 ms de latencia de control, como el hardware):
 *   1. la planta evoluciona con el mando ANTERIOR del driver
 *   2. los sensores leen el nuevo estado físico y generan flancos
 *   3. el firmware atiende las ISR, ejecuta el PI y emite el nuevo mando
 * ========================================================================== */

(function () {
  const CFG = SIM.CFG;

  let ultimo = 0, acumulador = 0, primerFrame = true;
  let tSim = 0, tUs = 0;
  let mando = { enaPwm: 0, in1: false, in2: false };
  let ultimoTrazadorMs = 0;
  let acumUI = 0, acumScope = 0;

  SIM.autoTrazador = false;
  SIM.velocidadTiempo = 1;
  let hay3D = false;

  function pasoFisica(dt) {
    tSim += dt;
    tUs += dt * 1e6;

    // 1. Planta
    SIM.Plant.step(dt, mando);

    // 2. Hardware: convierte física en señales eléctricas
    const eventos = SIM.Hardware.step(dt, tUs, SIM.Firmware.st.sensor);

    // 3. Firmware: solo ve flancos de pin y el ADC del shunt
    mando = SIM.Firmware.loop(dt, tUs, eventos, SIM.Hardware.adcCuentas);

    // Muestreo del osciloscopio a la frecuencia real de la física
    SIM.UI.muestrear(
      SIM.Plant.st.caudalSalidaMlS * 60,
      SIM.Firmware.st.setpointMlH / 60,
      SIM.Plant.presionMmHg(),
      SIM.Plant.st.corriente
    );

    // Inyección periódica del trazador
    if (SIM.autoTrazador && SIM.Firmware.st.sensor === 'optico' &&
      (SIM.Firmware.st.modo === 'INFUNDIENDO' || SIM.Firmware.st.modo === 'KVO')) {
      const ms = tSim * 1000;
      // Un único trazador entre inyección y S2 evita emparejar burbujas distintas.
      const enMedida = SIM.Plant.st.trazadores.some(tr =>
        tr.s - tr.longitudMm < SIM.Plant.S_SENSOR_2 + CFG.SENSOR_OPTICO.ANCHO_HAZ_MM);
      if (!enMedida && ms - ultimoTrazadorMs > CFG.TRAZADOR.INTERVALO_AUTO_MS) {
        ultimoTrazadorMs = ms;
        const inp = document.getElementById('inp-trazador-vol');
        const vol = inp ? parseFloat(inp.value) : CFG.TRAZADOR.VOLUMEN_ML;
        SIM.Plant.inyectarTrazador(vol);
      }
    }

    SIM.UI.registrarMasa(tSim);
  }

  function bucle(ts) {
    // La base de tiempos se toma del PRIMER fotograma, no de performance.now():
    // las marcas de requestAnimationFrame no tienen por qué compartir época, y
    // un desfase inicial dejaría el acumulador en negativo.
    if (primerFrame) { ultimo = ts; primerFrame = false; }

    // Blindaje del paso de tiempo. Sin el tope inferior, una marca de tiempo
    // que retroceda vuelve el acumulador negativo y la simulación se congela
    // en silencio, sin lanzar ningún error.
    let dtFrame = (ts - ultimo) / 1000;
    if (!(dtFrame > 0)) dtFrame = 0;
    if (dtFrame > CFG.MAX_FRAME_DT) dtFrame = CFG.MAX_FRAME_DT;
    ultimo = ts;
    acumulador += dtFrame * SIM.velocidadTiempo;

    let pasos = 0;
    while (acumulador >= CFG.FIXED_DT && pasos < 2500) {
      pasoFisica(CFG.FIXED_DT);
      acumulador -= CFG.FIXED_DT;
      pasos++;
    }
    if (pasos >= 2500) acumulador = 0;   // recuperación tras un stall largo

    // Dibujo 3D a la cadencia del navegador
    if (hay3D) SIM.Scene3D.actualizar();

    // El osciloscopio y el DOM no necesitan ir a 60 Hz
    acumScope += dtFrame;
    if (acumScope > 1 / 30) { acumScope = 0; SIM.UI.dibujarScope(); }
    acumUI += dtFrame;
    if (acumUI > 1 / 15) { acumUI = 0; SIM.UI.actualizarUI(); }

    SIM.UI.gestionarAudioAlarma(tSim);

    requestAnimationFrame(bucle);
  }

  function arrancar() {
    const host = document.getElementById('viewport-3d');

    if (typeof THREE === 'undefined') {
      host.innerHTML =
        '<div class="error-3d"><h3>No se pudo cargar Three.js</h3>' +
        '<p>La escena 3D necesita la biblioteca desde el CDN. Compruebe la conexión ' +
        'y recargue la página. El resto del simulador (física, telemetría y ' +
        'osciloscopio) sigue funcionando.</p></div>';
    } else {
      try {
        SIM.Scene3D.init(host);
        hay3D = true;
      } catch (error) {
        host.innerHTML = '<div class="error-3d"><h3>Vista 3D no disponible</h3>' +
          '<p>No se pudo iniciar WebGL. Las medidas, los controles y las gráficas siguen disponibles.</p></div>';
        console.error('No se pudo iniciar la escena 3D:', error);
      }
    }

    SIM.UI.init();

    // Estado inicial coherente con los controles del HTML.
    SIM.Firmware.setSetpoint(CFG.INFUSION.RITMO_INICIAL_ML_H);
    SIM.Plant.setDiametroReal(CFG.TUBO.D_REAL_MM);

    requestAnimationFrame(bucle);
  }

  window.addEventListener('DOMContentLoaded', arrancar);
})();
