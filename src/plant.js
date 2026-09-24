/* ============================================================================
 * PLANTA FÍSICA — motor DC, cabezal peristáltico, hidráulica y trazadores
 * ----------------------------------------------------------------------------
 * Este módulo es la REALIDAD del banco. El firmware simulado NO puede leerlo:
 * solo recibe señales de pin a través de hardware.js (auditoría P0-1).
 *
 * Modelos implementados:
 *   · Motor DC con escobillas: fem, resistencia de armadura, inercia y
 *     fricción de Coulomb. La zona muerta NO se codifica, EMERGE.
 *   · Cabezal peristáltico de desplazamiento positivo: el caudal nace de la
 *     rotación (Q = n·V_stroke·f), no al revés.
 *   · Hidráulica de parámetros concentrados: resistencia de Hagen-Poiseuille
 *     y compliancia del tubo → presión, oclusión y BOLO POST-OCLUSIÓN.
 *   · Trazadores de Taylor con velocidad distinta de la media (auditoría P0-8).
 * ========================================================================== */

(function () {
  const CFG = SIM.CFG;
  const U = SIM.util;

  /* ======================================================================
   * 1. TRAYECTORIA DEL CIRCUITO HIDRÁULICO
   * Definida una sola vez y compartida por la física y por la escena 3D,
   * de modo que la coordenada `s` (mm de recorrido) sea la misma en ambas.
   * Unidades: mm. Ejes: X derecha, Y arriba, Z hacia el observador.
   * ==================================================================== */
  const CONTROL_POINTS = [
    [-150, 15, -30],   // extremo sumergido, cerca del fondo del depósito pesado
    [-128, 18, -30],
    [-111, 18, 6],    // entrada tangencial al cabezal
    // Manguera continua alrededor de los tres rodillos (radio de paso 21 mm).
    ...Array.from({ length: 9 }, (_, i) => {
      const a = (210 - i * 30) * Math.PI / 180;
      return [-85 + 21 * Math.cos(a), 40 + 21 * Math.sin(a), 6];
    }),
    [-59, 18, 6],     // salida tangencial de la bomba
    [-20, 22, 30],     // puerto en Y — punto de inyección del trazador
    [18, 20, 30],
    [40, 26, 30],      // pie del montante vertical
    [40, 214, 30],     // cima del montante  ← TRAMO DE MEDIDA VERTICAL
    [72, 232, 30],
    [128, 232, 4],
    [140, 226, -18],
    [140, 138, -18]    // boca de descarga sobre el vaso colector
  ];

  // Catmull-Rom uniforme, sin dependencia de Three.js.
  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      out[i] = 0.5 * (
        2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3
      );
    }
    return out;
  }

  const Path = (function buildPath() {
    const cps = CONTROL_POINTS;
    const ext = [cps[0]].concat(cps, [cps[cps.length - 1]]);
    const samples = [];
    const PER_SEG = 48;
    for (let i = 0; i < ext.length - 3; i++) {
      for (let j = 0; j < PER_SEG; j++) {
        samples.push(catmull(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], j / PER_SEG));
      }
    }
    samples.push(cps[cps.length - 1].slice());

    // Tabla de longitud de arco: `s` acumulado en mm.
    const arc = [0];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      arc.push(arc[i - 1] + d);
    }
    const total = arc[arc.length - 1];

    function indexAt(s) {
      s = U.clamp(s, 0, total);
      let lo = 0, hi = arc.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (arc[mid] <= s) lo = mid; else hi = mid;
      }
      return lo;
    }

    return {
      samples, arc, total,
      /** Posición 3D (mm) a la distancia `s` recorrida desde el origen. */
      pointAt(s) {
        const i = indexAt(s);
        const seg = arc[i + 1] - arc[i] || 1e-9;
        const f = (U.clamp(s, 0, total) - arc[i]) / seg;
        const a = samples[i], b = samples[Math.min(i + 1, samples.length - 1)];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      },
      /** Tangente unitaria en `s`. */
      tangentAt(s) {
        const i = indexAt(s);
        const a = samples[i], b = samples[Math.min(i + 1, samples.length - 1)];
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const n = Math.hypot(d[0], d[1], d[2]) || 1e-9;
        return [d[0] / n, d[1] / n, d[2] / n];
      },
      /** true si el tramo en `s` es sensiblemente vertical (auditoría P0-8). */
      esVertical(s) { return Math.abs(this.tangentAt(s)[1]) > 0.7; },
      /** `s` del punto de la trayectoria más cercano a una posición del mundo. */
      sNearest(x, y, z) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < samples.length; i++) {
          const p = samples[i];
          const d = (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
        return arc[best];
      }
    };
  })();

  // Puntos de interés sobre la trayectoria, en mm de recorrido.
  const S_INYECCION = Path.sNearest(-20, 22, 30);
  const S_SENSOR_1 = Path.sNearest(40, 60, 30);
  const S_SENSOR_2 = Path.sNearest(40, 160, 30);
  const S_HALL = Path.sNearest(40, 110, 30);
  // Distancia REAL entre haces. El firmware usará la NOMINAL (100.0 mm):
  // cualquier diferencia se convierte en error metrológico legítimo.
  const D_REAL_SENSORES = S_SENSOR_2 - S_SENSOR_1;

  /* ======================================================================
   * 2. ESTADO DE LA PLANTA
   * ==================================================================== */
  const st = {
    // Eléctrico / mecánico
    omega: 0,              // rad/s en el eje del motor
    depositoMl: CFG.GRAVIMETRIA.VOLUMEN_INICIAL_ML,
    corriente: 0,          // A
    vMotor: 0,             // V medios en bornes del motor
    vSupply: CFG.ALIMENTACION.V_NOMINAL,
    anguloBomba: 0,        // rad en el cabezal
    // Hidráulico
    presionPa: 0,          // presión manométrica aguas abajo
    ocluido: false,
    caudalBombaMlS: 0,     // desplazado por el cabezal
    caudalSalidaMlS: 0,    // caudal de transporte aguas abajo de la compliancia
    caudalColectorMlS: 0,  // salida efectiva después de llenar el tramo vacío
    recorridoFlujoMm: 0,   // integral de velocidad para las marcas visuales
    velocidadMediaMmS: 0,
    // Volumen
    desplazadoMl: 0,       // total (líquido + aire)
    aireEntregadoMl: 0,
    liquidoEntregadoMl: 0,
    // Trazadores y cebado
    trazadores: [],
    frenteS: Path.total,   // posición del menisco; = total ⇒ circuito cebado
    // Balanza
    masaRealG: 0,
    masaIndicadaG: 0,
    evaporadoG: 0,
    // Desgaste y tiempo
    horasFuncionamiento: 0,
    tiempoSim: 0,
    // Geometría efectiva (se recalcula al cambiar el diámetro real)
    dRealMm: CFG.TUBO.D_REAL_MM,
    areaRealMm2: 0,
    mlPorRev: 0,
    fluido: CFG.FLUIDS[CFG.FLUIDO_POR_DEFECTO],
    // Instrumentación interna para la UI (verdad del modelo)
    corrienteBasalA: 0
  };

  function recalcularGeometria() {
    st.areaRealMm2 = U.areaMm2(st.dRealMm);
    const arcoPorRodillo = 2 * Math.PI * CFG.BOMBA.RADIO_ROTOR_MM / CFG.BOMBA.RODILLOS;
    // V/rev = n_rodillos · A_tubo · arco_barrido_por_rodillo   [mm³ → mL]
    st.mlPorRev = CFG.BOMBA.RODILLOS * st.areaRealMm2 * arcoPorRodillo / 1000;
  }
  recalcularGeometria();

  /* Resistencia hidráulica del tramo de descarga (Hagen-Poiseuille):
   *      R = 128 · µ · L / (π · D⁴)        [Pa·s/m³]                        */
  function resistenciaLinea() {
    const D = st.dRealMm * 1e-3;
    const R = 128 * st.fluido.mu * CFG.TUBO.LONGITUD_DESCARGA_M / (Math.PI * Math.pow(D, 4));
    return st.ocluido ? R * CFG.TUBO.FACTOR_OCLUSION : R;
  }

  /* Altura manométrica neta que debe vencer la bomba (montante - descarga). */
  function presionHidrostatica() {
    const hNetoM = (214 - 138) * 1e-3;   // cima del montante − boca de descarga
    return st.fluido.rho * 9.80665 * hNetoM;
  }

  /* Rizado del cabezal peristáltico: componente senoidal más la caída del
   * relevo entre rodillos. Un cabezal real riza entre el 5 % y el 20 %.     */
  function rizado(theta) {
    const ph = ((theta * CFG.BOMBA.RODILLOS) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const dip = Math.exp(-Math.pow(ph - Math.PI, 2) / 0.12);
    return 1 + CFG.BOMBA.RIZADO_SENO * Math.sin(ph) - CFG.BOMBA.RIZADO_CAIDA * dip;
  }

  /* Factor de perfil del trazador (auditoría P0-8).
   * Interpola entre burbuja puntual y tapón de Taylor según L/D, y entre
   * tramo horizontal y vertical según la orientación local del tubo.        */
  function kPerfil(LsobreD, vertical) {
    const T = CFG.TRAZADOR;
    const t = U.clamp(LsobreD / T.L_SOBRE_D_TAYLOR, 0, 1);
    const kPeq = vertical ? T.K_PERFIL_VERTICAL_PEQUENA : T.K_PERFIL_HORIZ_PEQUENA;
    const kTay = vertical ? T.K_PERFIL_VERTICAL_TAYLOR : T.K_PERFIL_HORIZ_TAYLOR;
    return kPeq + (kTay - kPeq) * t;
  }

  /* ======================================================================
   * 3. PASO DE INTEGRACIÓN (dt fijo = 1 ms)
   * `mando` son las salidas del driver: {enaPwm 0..255, in1, in2}
   * ==================================================================== */
  function step(dt, mando) {
    const M = CFG.MOTOR, A = CFG.ALIMENTACION, L = CFG.L298N, B = CFG.BOMBA;

    st.tiempoSim += dt;

    /* --- 3.1 Etapa de potencia: L298N + fuente ------------------------ */
    // El puente solo conduce si la dirección está definida (IN1 ≠ IN2).
    const habilitado = (mando.in1 !== mando.in2) && mando.enaPwm > 0;
    const duty = habilitado ? mando.enaPwm / 255 : 0;

    // Caída de la fuente conmutada bajo carga, más rizado.
    st.vSupply = A.V_NOMINAL - Math.abs(st.corriente) * A.R_INTERNA
      + U.gauss(A.RIZADO_V);

    // Caída TOTAL del puente bipolar (transistor alto + bajo en serie).
    const vDrop = L.V_DROP_BASE + L.V_DROP_POR_A * Math.abs(st.corriente);
    st.vMotor = Math.max(0, duty * (st.vSupply - vDrop));

    /* --- 3.2 Motor DC -------------------------------------------------- */
    // Constante eléctrica L/R ≈ 60 µs ≪ dt ⇒ corriente cuasi-estática.
    st.corriente = (st.vMotor - M.Ke * st.omega) / M.R;

    // Par resistente hidráulico: la bomba debe hacer trabajo P·Q.
    const vRevM3 = st.mlPorRev * 1e-6;
    const tHidraulico = st.presionPa * vRevM3 / (2 * Math.PI)
      / (B.RELACION_REDUCTORA * B.RENDIMIENTO_REDUCTORA);
    // Al subir la presión los rodillos aprietan más: ésta es la vía por la
    // que la CORRIENTE delata la oclusión (auditoría P1-8.6).
    const tApriete = M.K_APRIETE * st.presionPa;
    const tFriccion = M.T_FRICCION + tApriete;

    let tNeto = M.Kt * st.corriente - tHidraulico - M.B_VISCOSA * st.omega;

    // Fricción de Coulomb: de aquí sale la zona muerta, sin codificarla.
    if (Math.abs(st.omega) < 1e-3) {
      if (Math.abs(tNeto) <= tFriccion) { tNeto = 0; st.omega = 0; }
      else tNeto -= Math.sign(tNeto) * tFriccion;
    } else {
      tNeto -= Math.sign(st.omega) * tFriccion;
    }

    st.omega += (tNeto / M.J) * dt;
    if (st.omega < 0) st.omega = 0;   // válvula antirretorno: no gira al revés

    st.corrienteBasalA = M.T_FRICCION / M.Kt;

    /* --- 3.3 Cabezal peristáltico: el caudal NACE de la rotación ------- */
    const omegaBomba = st.omega / B.RELACION_REDUCTORA;   // rad/s
    st.anguloBomba = (st.anguloBomba + omegaBomba * dt) % (2 * Math.PI);
    const revPorSeg = omegaBomba / (2 * Math.PI);

    const slip = U.clamp(1 - B.SLIP_POR_PA * st.presionPa, 0, 1);
    const fluencia = U.clamp(1 - B.FLUENCIA_POR_HORA * st.horasFuncionamiento, 0.6, 1);
    st.caudalBombaMlS = revPorSeg * st.mlPorRev * rizado(st.anguloBomba) * slip * fluencia;
    if (st.caudalBombaMlS < 0) st.caudalBombaMlS = 0;
    // El depósito es finito. Solo entra a la bomba el líquido disponible.
    const aspiradoMl = Math.min(st.depositoMl, st.caudalBombaMlS * dt);
    st.depositoMl = Math.max(0, st.depositoMl - aspiradoMl);
    st.caudalBombaMlS = aspiradoMl / dt;

    if (st.omega > 1) st.horasFuncionamiento += dt / 3600;

    /* --- 3.4 Hidráulica: compliancia del tubo y presión ---------------- */
    // dP/dt = (Q_bomba − (P − P_h)/R) / C   → solución exponencial exacta,
    // incondicionalmente estable (R·C ≈ 0.3 ms ≪ dt sin oclusión).
    const R = resistenciaLinea();
    const C = CFG.TUBO.COMPLIANCIA_M3_PA;
    const Ph = presionHidrostatica();
    const Qp = st.caudalBombaMlS * 1e-6;            // m³/s
    const tau = R * C;
    const Pinf = Ph + Qp * R;
    const Pant = st.presionPa;
    st.presionPa = Pinf + (Pant - Pinf) * Math.exp(-dt / tau);

    // El caudal de salida se obtiene por CONSERVACIÓN DE MASA sobre el paso:
    //     V_sale = V_entra − ΔV_almacenado_en_la_compliancia
    // Muestrear Q = (P−Ph)/R al final del paso perdería por completo el bolo
    // post-oclusión, porque al liberar la pinza τ = R·C ≈ 0.3 ms ≪ dt y toda
    // la descarga ocurriría entre dos muestras.
    let dVm3 = Qp * dt - C * (st.presionPa - Pant);
    if (dVm3 < 0) dVm3 = 0;                         // la válvula check no deja volver
    const QoutM3 = dVm3 / dt;
    st.caudalSalidaMlS = QoutM3 * 1e6;

    /* --- 3.5 Cinemática del fluido en el tubo -------------------------- */
    // V = Q/A es la velocidad MEDIA. Los trazadores NO viajan a esta
    // velocidad: ver kPerfil() (auditoría P0-8).
    const qMm3S = st.caudalSalidaMlS * 1000;
    st.velocidadMediaMmS = qMm3S / st.areaRealMm2;

    /* --- 3.6 Volumen entregado y contabilidad del aire ----------------- */
    const dV = st.caudalSalidaMlS * dt;
    st.recorridoFlujoMm += st.velocidadMediaMmS * dt;

    /* --- 3.7 Cebado (método del menisco de la guía §1.2) --------------- */
    const volumenPorLlenarMl = Math.max(0, Path.total - st.frenteS) * st.areaRealMm2 / 1000;
    const volumenAlColectorMl = Math.max(0, dV - volumenPorLlenarMl);
    st.caudalColectorMlS = volumenAlColectorMl / dt;
    st.desplazadoMl += volumenAlColectorMl;
    if (st.frenteS < Path.total) {
      st.frenteS = Math.min(Path.total, st.frenteS + st.velocidadMediaMmS * dt);
    }

    /* --- 3.8 Transporte de trazadores --------------------------------- */
    for (let i = st.trazadores.length - 1; i >= 0; i--) {
      const tr = st.trazadores[i];
      const vertical = Path.esVertical(tr.s);
      const k = kPerfil(tr.longitudMm / st.dRealMm, vertical) * tr.kVariacion;
      tr.kEfectivo = k;
      tr.vMmS = k * st.velocidadMediaMmS;
      tr.sPrev = tr.s;
      tr.s += tr.vMmS * dt;
      if (tr.s - tr.longitudMm > Path.total) {
        st.aireEntregadoMl += tr.volumenMl;
        st.trazadores.splice(i, 1);
      }
    }

    st.liquidoEntregadoMl = Math.max(0, st.desplazadoMl - st.aireEntregadoMl);

    /* --- 3.9 Balanza gravimétrica -------------------------------------- */
    // El aire NO pesa: contabilizarlo como agua era el autoengaño del
    // simulador anterior (auditoría P0-7).
    const rhoGml = st.fluido.rho / 1000;
    st.evaporadoG += (CFG.BALANZA.EVAPORACION_G_H / 3600) * dt;
    st.masaRealG = Math.max(0,
      st.liquidoEntregadoMl * rhoGml * (1 - CFG.BALANZA.CORRECCION_EMPUJE) - st.evaporadoG);
    const bruta = st.masaRealG + U.gauss(CFG.BALANZA.RUIDO_SIGMA_G);
    st.masaIndicadaG = Math.round(bruta / CFG.BALANZA.RESOLUCION_G) * CFG.BALANZA.RESOLUCION_G;
  }

  /* ======================================================================
   * 4. ACCIONES EXTERNAS
   * ==================================================================== */
  let contadorTrazador = 0;

  function inyectarTrazador(volumenMl) {
    if (st.frenteS < Path.total) return null;
    if (st.trazadores.length >= CFG.TRAZADOR.MAX_EN_VUELO) return null;
    const vol = volumenMl === undefined ? CFG.TRAZADOR.VOLUMEN_ML : volumenMl;
    if (!Number.isFinite(vol) || vol <= 0 || vol > 1) return null;
    const volMm3 = vol * 1000;
    // Si el volumen llena la sección, es un tapón de Taylor de longitud L.
    // Si no, es una burbuja esférica de diámetro equivalente.
    const lTapon = volMm3 / st.areaRealMm2;
    const dEsfera = Math.cbrt(6 * volMm3 / Math.PI);
    const esTapon = dEsfera >= st.dRealMm;
    const longitud = esTapon ? lTapon : dEsfera;

    contadorTrazador++;
    const tr = {
      id: contadorTrazador,
      s: S_INYECCION,
      sPrev: S_INYECCION,
      volumenMl: vol,
      longitudMm: longitud,
      esTapon,
      // Variabilidad burbuja a burbuja: deformación, mojado de pared, etc.
      kVariacion: 1 + U.gauss(0.02),
      kEfectivo: 1,
      vMmS: 0,
      t1: null, t2: null
    };
    st.trazadores.push(tr);
    return tr;
  }

  function setOclusion(v) { st.ocluido = !!v; }

  function purgar() {
    st.trazadores.length = 0;
    st.frenteS = Path.total;
    st.presionPa = 0;
  }

  function vaciarParaCebado() {
    st.trazadores.length = 0;
    st.frenteS = S_INYECCION;   // el circuito queda vacío desde el puerto en Y
  }

  function tararBalanza() {
    st.evaporadoG = 0;
    st.desplazadoMl = 0;
    st.aireEntregadoMl = 0;
    st.liquidoEntregadoMl = 0;
    st.masaRealG = 0;
    st.masaIndicadaG = 0;
  }

  function setDiametroReal(mm) {
    if (!Number.isFinite(mm) || mm <= 0) return;
    st.dRealMm = U.clamp(mm, 1.0, CFG.TUBO.D_EXT_MM - 0.2);
    recalcularGeometria();
  }

  function setFluido(clave) {
    st.fluido = CFG.FLUIDS[clave] || st.fluido;
  }

  function reiniciarDesgaste() { st.horasFuncionamiento = 0; }

  /* ======================================================================
   * 5. API PÚBLICA
   * ==================================================================== */
  SIM.Plant = {
    st, Path, step, CONTROL_POINTS,
    S_INYECCION, S_SENSOR_1, S_SENSOR_2, S_HALL, D_REAL_SENSORES,
    inyectarTrazador, setOclusion, purgar, vaciarParaCebado, tararBalanza,
    masaDepositoG() { return CFG.GRAVIMETRIA.TARA_DEPOSITO_G + st.depositoMl * st.fluido.rho / 1000; },
    setDiametroReal, setFluido, reiniciarDesgaste,
    presionMmHg() { return U.mmHg(st.presionPa); },
    // Volumen almacenado en la compliancia del tubo: es el BOLO que saldrá
    // de golpe al liberar la oclusión (auditoría P0-6).
    volumenAlmacenadoMl() {
      return CFG.TUBO.COMPLIANCIA_M3_PA * st.presionPa * 1e6;
    }
  };
})();
