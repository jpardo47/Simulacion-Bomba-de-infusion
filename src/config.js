/* ============================================================================
 * CONFIGURACIÓN FÍSICA CENTRALIZADA
 * ----------------------------------------------------------------------------
 * Todas las constantes del modelo viven aquí, con su unidad y su procedencia.
 * Regla: ninguna constante física puede aparecer literal dentro de la lógica.
 *
 * NOTA DE TRAZABILIDAD (auditoría §7): las cifras marcadas [DATASHEET] deben
 * verificarse contra la hoja de datos del fabricante antes de usarse en un
 * informe. Las marcadas [MODELO] son parámetros de ajuste del simulador
 * elegidos para reproducir el comportamiento cualitativo correcto.
 * ========================================================================== */

window.SIM = window.SIM || {};

SIM.CFG = {
  GRAVIMETRIA: {
    VOLUMEN_INICIAL_ML: 250, TARA_DEPOSITO_G: 60, CAPACIDAD_G: 500,
    PERIODO_MUESTRA_S: 0.1, VENTANA_S: 30, RESOLUCION_G: 0.01,
    RUIDO_G: 0.008, GANANCIA: 1.003, OFFSET_G: 0.3,
    // Parámetros didácticos de celda + montaje, no resolución garantizada del HX711.
    RHO_NOMINAL_G_ML: 0.9982
  },

  /* --- Integración numérica ------------------------------------------- */
  // Auditoría P1-3: la física NO puede ir acoplada al frame rate.
  FIXED_DT: 0.001,          // s  — paso fijo del integrador (1 kHz)
  MAX_FRAME_DT: 0.25,       // s  — tope de acumulación tras un stall de pestaña

  /* --- Fluido ---------------------------------------------------------- */
  FLUIDS: {
    agua: {
      nombre: 'Agua destilada',
      rho: 998.2,           // kg/m³  @20 °C
      mu: 1.002e-3,         // Pa·s   @20 °C
      sigma: 0.0728         // N/m    tensión superficial agua/aire @20 °C
    },
    salina: {
      nombre: 'Solución salina 0.9 % NaCl',
      // Auditoría P2-3: la salina NO tiene la densidad del agua.
      rho: 1004.6,          // kg/m³  @20 °C
      mu: 1.030e-3,         // Pa·s
      sigma: 0.0740         // N/m
    }
  },
  FLUIDO_POR_DEFECTO: 'agua',

  /* --- Tubo ------------------------------------------------------------ */
  TUBO: {
    // Auditoría P1-5: el diámetro NOMINAL y el REAL son cosas distintas.
    // Q ∝ D², así que u(Q)/Q = 2·u(D)/D. Con ±0.15 mm sobre 4 mm → 7.5 %.
    D_NOMINAL_MM: 4.0,      // lo que el firmware cree que mide el tubo
    D_REAL_MM: 4.12,        // lo que mide de verdad (editable en la UI)
    TOLERANCIA_MM: 0.15,    // [DATASHEET] silicona grado comercial
    D_EXT_MM: 6.0,
    LONGITUD_DESCARGA_M: 0.50,  // tramo aguas abajo de los sensores
    // Compliancia hidráulica: dV/dP del tubo de silicona presurizado.
    // [MODELO] ajustado para que la alarma de oclusión a 500 mmHg tarde ~8 s
    // a 2 mL/min, que es el orden de magnitud real de una línea de infusión.
    COMPLIANCIA_M3_PA: 4.0e-12,   // m³/Pa  (= 0.004 mL/kPa)
    FACTOR_OCLUSION: 1e6          // multiplicador de R al pinzar
  },

  /* --- Bomba peristáltica ---------------------------------------------- */
  // Dispositivo de DESPLAZAMIENTO POSITIVO: el caudal nace de la rotación,
  // no al revés (auditoría P0-1, P1-18).
  BOMBA: {
    RODILLOS: 3,
    RADIO_ROTOR_MM: 15.0,
    RELACION_REDUCTORA: 400,      // [MODELO] motor:cabezal
    RENDIMIENTO_REDUCTORA: 0.55,  // [MODELO]
    // V/rev = n_rodillos · A_tubo · arco_por_rodillo
    //       = 3 · 13.33 mm² · (2π·15/3 mm) = 1.18 mL/rev  (con D real 4.12)
    // Se recalcula en runtime a partir del diámetro real.
    RIZADO_SENO: 0.06,            // [MODELO] componente senoidal del rizado
    RIZADO_CAIDA: 0.10,           // [MODELO] caída en el relevo de rodillos
    // Deslizamiento volumétrico: el tubo no recupera del todo bajo presión.
    SLIP_POR_PA: 6.0e-8,          // [MODELO] fracción de caudal perdida por Pa
    // Fluencia del elastómero: el tubo pierde caudal con las horas de uso.
    FLUENCIA_POR_HORA: 0.04       // [MODELO] 4 %/h — auditoría §4.4
  },

  /* --- Motor DC con escobillas ------------------------------------------ */
  // El "deadzone" NO se codifica: emerge de la fricción de Coulomb.
  MOTOR: {
    Ke: 0.0075,        // V·s/rad  constante de fem
    Kt: 0.0075,        // N·m/A    constante de par (= Ke en SI)
    R: 8.0,            // Ω        resistencia de armadura
    J: 4.0e-7,         // kg·m²    inercia efectiva (rotor + reductora + fluido)
    B_VISCOSA: 1.2e-8, // N·m·s/rad
    T_FRICCION: 1.2e-3,// N·m      fricción seca referida al eje del motor
    // El apriete de los rodillos crece con la presión → más par resistente.
    // Es la vía física por la que la corriente delata la oclusión (P1-8.6).
    K_APRIETE: 9.0e-9  // N·m/Pa
  },

  /* --- Alimentación y driver L298N -------------------------------------- */
  ALIMENTACION: {
    V_NOMINAL: 12.0,      // V
    R_INTERNA: 0.5,       // Ω  caída de la fuente bajo carga
    RIZADO_V: 0.05        // V  rizado pico de la conmutada
  },
  L298N: {
    // [DATASHEET] ST L298 — caída TOTAL (transistor alto + bajo en serie).
    // Auditoría P1-8.1: típ 1.8 V @1 A, 2.7 V @2 A. Modelo lineal V = a + b·I.
    V_DROP_BASE: 1.40,    // V   a corriente nula
    V_DROP_POR_A: 0.90,   // V/A pendiente
    PWM_BITS: 8,          // Auditoría P0-5: 256 niveles, ni uno más
    F_PWM_HZ: 3922        // Timer1 con preescaler /8 (auditoría P1-8.4)
  },

  /* --- Sensores ópticos de tiempo de vuelo ------------------------------ */
  SENSOR_OPTICO: {
    // Auditoría P1-2: el haz real mide ~1 mm, no 11 mm.
    ANCHO_HAZ_MM: 1.0,
    // Jitter de detección exigido por la skill fluid-simulation (P1-4).
    JITTER_REL: 0.03,        // ±3 % sobre el instante de cruce
    JITTER_ABS_US: 120,      // µs  ruido de umbral del comparador
    HISTERESIS: 0.15,        // fracción de solape para conmutar (anti-rebote)
    DISTANCIA_NOMINAL_MM: 100.0  // lo que el firmware cree que hay entre haces
  },

  /* --- Turbina de efecto Hall YF-S401 ----------------------------------- */
  HALL: {
    // [DATASHEET] F(Hz) = 98 · Q(L/min)  →  5.88 pulsos/mL (auditoría P1-7)
    K_PULSOS_POR_ML: 5.88,
    // El rotor NO arranca por debajo de su caudal mínimo. La guía §1.3 lo dice
    // y el simulador antiguo lo ignoraba.
    Q_ARRANQUE_ML_MIN: 200.0,
    Q_NOMINAL_MIN_ML_MIN: 300.0,
    Q_NOMINAL_MAX_ML_MIN: 6000.0,
    // No linealidad de K cerca del umbral inferior.
    NO_LINEALIDAD: 0.18
  },

  /* --- Trazador (microburbuja de Taylor) -------------------------------- */
  TRAZADOR: {
    VOLUMEN_ML: 0.05,        // jeringa de insulina, según la guía §1.2
    // Auditoría P0-8: la burbuja NO viaja a la velocidad media.
    // k_perfil depende de L/D y de la orientación del tramo.
    K_PERFIL_VERTICAL_TAYLOR: 1.00,  // Eo = 2.18 < 3.37 → sin deriva
    K_PERFIL_VERTICAL_PEQUENA: 1.85, // burbuja puntual sobre el eje (~2·V_media)
    K_PERFIL_HORIZ_TAYLOR: 0.88,     // roza la generatriz superior
    K_PERFIL_HORIZ_PEQUENA: 0.62,    // estratificada en zona lenta
    L_SOBRE_D_TAYLOR: 0.9,           // umbral L/D para considerarla tapón
    MAX_EN_VUELO: 8,
    INTERVALO_AUTO_MS: 9000
  },

  /* --- Balanza gravimétrica --------------------------------------------- */
  BALANZA: {
    RESOLUCION_G: 0.01,      // auditoría P1-4: la balanza cuantiza
    RUIDO_SIGMA_G: 0.005,
    EVAPORACION_G_H: 0.25,   // vaso abierto, ambiente de laboratorio
    // Empuje del aire sobre el agua: ~0.1 % — relevante si se persigue el 1 %.
    CORRECCION_EMPUJE: 0.0011
  },

  /* --- Control (firmware) ------------------------------------------------ */
  CONTROL: {
    // Skill pid-controller: setpoint en Vxmm, PV = d/Δt.
    KP: 0.5,
    KI: 0.015,                // 1/s   — la I que faltaba (auditoría P0-2)
    MAX_PASO_INTEGRAL_S: 5,  // [MODELO] limita correcciones con muestras ToF muy separadas
    DEADBAND_MM_S: 0.15,     // zona muerta, exigida por la skill
    I_MIN: -80, I_MAX: 80,   // límites del acumulador (anti-windup por clamping)
    // Auditoría P0-1: el feedforward NO puede conocer la planta exactamente.
    FF_DESAJUSTE: 0.88,      // el firmware estima un 12 % por debajo
    PERIODO_HALL_MS: 1000,   // ventana de muestreo de la opción B
    TIMEOUT_TRANSITO_MS: 45000, // mínimo; se amplía según el tránsito nominal
    FACTOR_TIMEOUT_TRANSITO: 3
  },

  /* --- Alarmas (IEC 60601-1-8: prioridades) ------------------------------ */
  ALARMAS: {
    P_OCLUSION_MMHG: 500,        // umbral de presión de oclusión de referencia
    // Criterio RELATIVO: sensible, pero depende de una basal bien aprendida.
    I_OCLUSION_FACTOR: 1.25,     // 25 % por encima de la corriente basal
    // Criterio ABSOLUTO: red de seguridad independiente de la basal. Sin él,
    // una oclusión ya presente durante el aprendizaje envenena la referencia y
    // la alarma se retrasa indefinidamente mientras la presión sigue subiendo.
    I_ABSOLUTA_A: 0.32,          // ≈700 mmHg con esta bomba — dispara siempre
    I_BASAL_MAX_A: 0.24,         // una basal por encima de esto NO es una basal
    T_SOSTENIDO_REL_S: 1.5,      // confirmación del criterio relativo
    T_SOSTENIDO_ABS_S: 0.3,      // el límite duro actúa deprisa
    AIRE_BOLO_UL: 50,            // burbuja única > 50 µL → alarma
    AIRE_ACUMULADO_ML_H: 1.0,    // aire acumulado en ventana móvil de 1 h
    KVO_ML_H: 5.0,               // ritmo de mantenimiento de vía al fin del VTBI
    PAUSA_AUDIO_S: 120           // pausa de audio normalizada, no "mute" eterno
  },

  /* --- Bolo -------------------------------------------------------------- */
  BOLO: {
    // Auditoría P1-12: un bolo es una DOSIS, no un interruptor enclavado.
    VOLUMEN_ML: 2.0,
    VELOCIDAD_ML_H: 600.0,
    VELOCIDAD_MAX_ML_H: 1200.0
  },

  /* --- Infusión ---------------------------------------------------------- */
  INFUSION: {
    VTBI_ML: 250.0,
    RITMO_INICIAL_ML_H: 120.0,
    RITMO_MIN_ML_H: 1.0,
    RITMO_MAX_ML_H: 1200.0
  },

  /* --- Osciloscopio ------------------------------------------------------ */
  SCOPE: {
    MUESTRAS: 2400,          // 2.4 s a 1 kHz — ahora sí resuelve los pulsos
    FS_HZ: 1000
  }
};

/* --- Utilidades numéricas compartidas ---------------------------------- */
SIM.util = {
  // Ruido gaussiano (Box-Muller). Exigido por la skill fluid-simulation.
  gauss(sigma) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  },
  clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); },
  // Filtro de primer orden EXACTO, independiente del paso (auditoría P1-3).
  lpf(actual, objetivo, tau, dt) {
    const a = 1 - Math.exp(-dt / tau);
    return actual + (objetivo - actual) * a;
  },
  PA_POR_MMHG: 133.322,
  mmHg(pa) { return pa / 133.322; },
  areaMm2(dMm) { return Math.PI * dMm * dMm / 4; }
};

/* --- Bus de eventos: único canal entre el firmware y la interfaz -------- */
SIM.bus = (function () {
  const subs = {};
  return {
    on(ev, fn) { (subs[ev] = subs[ev] || []).push(fn); },
    emit(ev, data) {
      const l = subs[ev];
      if (!l) return;
      for (let i = 0; i < l.length; i++) l[i](data);
    }
  };
})();
