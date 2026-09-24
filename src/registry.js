/* ============================================================================
 * REGISTRO DE COMPONENTES
 * ----------------------------------------------------------------------------
 * Ficha técnica de cada pieza del banco. Se muestra únicamente cuando el
 * usuario selecciona el componente en la escena 3D (auditoría §5.5).
 *
 * Cada ficha contiene, además de la especificación:
 *   (a) el papel del componente dentro del lazo
 *   (b) su contribución al presupuesto de incertidumbre
 *   (c) su modo de fallo característico
 *   (d) los valores EN VIVO que le corresponden en ese instante
 *
 * Las cotas marcadas [VERIFICAR] son valores de partida típicos: confírmense
 * contra el datasheet o la pieza física antes de usarlas en un informe.
 * ========================================================================== */

(function () {
  const U = SIM.util;
  const P = () => SIM.Plant.st;
  const F = () => SIM.Firmware.st;
  const K = () => SIM.Firmware.konst;
  const H = () => SIM.Hardware;
  const CFG = SIM.CFG;

  const n = (x, d) => (x === undefined || x === null || !isFinite(x)) ? '—' : x.toFixed(d);

  SIM.Registry = {
    loadcell: {
      nombre: 'Celda de carga del depósito · 500 g', ref: 'Puente de galgas extensométricas', categoria: 'Medición de masa',
      cotas: '47 × 12 × 6 mm · envolvente ilustrativa',
      especificaciones: [['Capacidad total','500 g incluyendo recipiente'],['Depósito inicial','250 mL'],['Tara simulada','60 g'],['Lectura','Puente de galgas → HX711']],
      papel: 'Mide la masa del depósito sin tocar el líquido. Su pérdida por unidad de tiempo permite estimar el caudal aspirado. La balanza de salida verifica la entrega.',
      incertidumbre: 'Ruido, vibración, deriva térmica y fuerza de la manguera. La resolución simulada de 0.01 g es una hipótesis del montaje, no una precisión garantizada por el ADC.',
      fallo: 'Tubo tenso, recipiente apoyado fuera de la plataforma, sobrecarga o calibración incorrecta.',
      vivo: () => [['Masa HX711',n(H().pesoDepositoG,2)+' g'],['Restante (modelo)',n(P().depositoMl,2)+' mL']]
    },
    hx711: {
      nombre: 'HX711 · lectura de celda de carga', ref: 'ADC de puente resistivo', categoria: 'Adquisición', cotas: 'Módulo ilustrativo 34 × 22 mm',
      especificaciones: [['Muestras simuladas','10 por segundo'],['Conexión propuesta','DOUT → D4 · SCK → D5'],['Ventana','30 s · pendiente por regresión'],['Alimentación propuesta','5 V · masa común con Nano']],
      papel: 'Entrega muestras de peso al firmware. El cálculo del caudal utiliza la pendiente de esas muestras y la densidad programada; no consulta el caudal interno de la planta.',
      incertidumbre: 'Ganancia, offset y ruido de la cadena completa. Calibrar con masas conocidas antes de derivar el caudal.',
      fallo: 'Cableado de excitación o señal invertido, falta de calibración y ruido del motor.',
      vivo: () => [['Masa',n(H().pesoDepositoG,2)+' g'],['Caudal estimado',n(F().qMedidaMlMin*60,2)+' mL/h'],['Ventana',n(F().ventanaPesoS,1)+' s']]
    },

    mcu: {
      nombre: 'Arduino Nano v3',
      ref: 'ATmega328P · 16 MHz',
      categoria: 'Control',
      cotas: '45 × 18 × 7 mm  ·  PCB de 30 pines',
      especificaciones: [
        ['Microcontrolador', 'ATmega328P, 8 bits, 16 MHz'],
        ['Memoria', '32 KB Flash · 2 KB SRAM · 1 KB EEPROM'],
        ['Resolución de micros()', '4 µs (Timer0, preescaler 64)'],
        ['Interrupciones externas', 'INT0 = D2 · INT1 = D3'],
        ['PWM de Timer1', 'D9 y D10 · 490 Hz por defecto'],
        ['Resolución de analogWrite', '8 bits (0–255)'],
        ['ADC', '10 bits · Vref 5 V · ~9.6 kSa/s'],
        ['Regulador a bordo', 'AMS1117, ~500 mA (limitado térmicamente)']
      ],
      papel: 'Ejecuta las ISR de los sensores, el lazo PI y la máquina de alarmas. Solo conoce el tubo a través de sus constantes nominales guardadas en EEPROM.',
      incertidumbre: 'Aporta muy poco: la cuantización de micros() a 4 µs sobre un Δt de segundos es despreciable (<0.001 %). El término que sí domina es la resolución de 8 bits de la SALIDA PWM.',
      fallo: 'Reinicios espurios por ruido de conmutación del motor si comparte la línea de 5 V con la potencia. Desbordamiento de micros() a los 71.6 minutos: la resta sin signo lo absorbe correctamente.',
      vivo: () => [
        ['micros()', `${(F().t_us / 1e6).toFixed(2)} s`],
        ['analogWrite(D9)', `${F().pwm} / 255`],
        ['D8 (IN1)', F().in1 ? 'HIGH' : 'LOW'],
        ['D7 (IN2)', F().in2 ? 'HIGH' : 'LOW'],
        ['D2 (INT0)', H().pines.D2 ? 'HIGH' : 'LOW'],
        ['D3 (INT1)', H().pines.D3 ? 'HIGH' : 'LOW'],
        ['ADC corriente', `${F().adcCorriente} cuentas`]
      ]
    },

    driver: {
      nombre: 'Módulo puente H L298N',
      ref: 'ST L298N · Multiwatt15',
      categoria: 'Potencia',
      cotas: '≈43 × 43 × 27 mm con disipador  [VERIFICAR]',
      especificaciones: [
        ['Topología', 'Puente completo doble, transistores BIPOLARES'],
        ['Tensión de potencia (Vs)', '5 – 46 V'],
        ['Corriente por canal', '2 A continuos · 3 A de pico'],
        ['Caída TOTAL (alto + bajo)', 'típ 1.8 V @1 A · 2.7 V @2 A  [DATASHEET]'],
        ['Máximo de caída', '3.2 V @1 A · 4.9 V @2 A  [DATASHEET]'],
        ['Diodos de recirculación', 'NO los lleva internos → 8 externos rápidos'],
        ['Regulador lógico a bordo', '78M05 (quitar el jumper si Vs > 12 V)'],
        ['Pines SENSE A/B', 'Puenteados a masa en casi todos los módulos'],
        ['Frecuencia de PWM práctica', '3.9 – 8 kHz (a 31 kHz se dispara la pérdida)']
      ],
      papel: 'Modula la tensión media aplicada a la bomba. En este montaje el PWM entra por ENA, lo que produce DECAIMIENTO RÁPIDO: el motor rueda libre durante el tiempo de apagado.',
      incertidumbre: 'Su caída de tensión depende de la corriente, así que la relación duty→caudal no es lineal. Por eso el lazo necesita término integral y por eso el feedforward solo no basta.',
      fallo: 'Sobrecalentamiento por encima de 1 A con el disipador de serie. Si se retira el jumper de 5 V sin alimentar el pin correspondiente, la lógica del integrado queda muerta y el motor no gira sin ningún síntoma evidente.',
      vivo: () => [
        ['Duty ENA', `${(F().pwm / 255 * 100).toFixed(1)} %`],
        ['V fuente', `${n(P().vSupply, 2)} V`],
        ['Caída del puente', `${n(CFG.L298N.V_DROP_BASE + CFG.L298N.V_DROP_POR_A * Math.abs(P().corriente), 2)} V`],
        ['V medios al motor', `${n(P().vMotor, 2)} V`],
        ['Corriente', `${n(P().corriente, 3)} A`],
        ['Disipación estimada', `${n(Math.abs(P().corriente) * (CFG.L298N.V_DROP_BASE + CFG.L298N.V_DROP_POR_A * Math.abs(P().corriente)), 2)} W`]
      ]
    },

    pump: {
      nombre: 'Bomba peristáltica 12 V con reductora',
      ref: 'Cabezal de 3 rodillos',
      categoria: 'Actuador',
      cotas: 'Cabezal ilustrativo Ø54 mm · radio de rodillos 15 mm',
      especificaciones: [
        ['Principio', 'DESPLAZAMIENTO POSITIVO — el caudal nace de la rotación'],
        ['Rodillos', `${CFG.BOMBA.RODILLOS}`],
        ['Radio del rotor', `${CFG.BOMBA.RADIO_ROTOR_MM} mm`],
        ['Relación de reducción', `${CFG.BOMBA.RELACION_REDUCTORA}:1`],
        ['Rendimiento de la reductora', `${(CFG.BOMBA.RENDIMIENTO_REDUCTORA * 100).toFixed(0)} %`],
        ['Rizado de caudal', '5 – 20 % con caída en el relevo de rodillos'],
        ['Motor', 'DC con escobillas · Ke = Kt = 0.0075 V·s/rad · R = 8 Ω'],
        ['Zona muerta', 'NO programada: emerge de la fricción de Coulomb']
      ],
      papel: 'Los tres rodillos comprimen sucesivamente la manguera de silicona y desplazan el líquido. El rotor visible sigue el ángulo del modelo físico, con reducción 400:1. El modelo incluye rizado, pérdida volumétrica por presión y desgaste del tubo.',
      incertidumbre: 'El volumen por vuelta se estima con el diámetro real del tubo y un radio efectivo de 15 mm. La fluencia se modela al 4 %/h. Son parámetros didácticos pendientes de calibración; la geometría visible no es un plano de fabricación ni resuelve la deformación del elastómero.',
      fallo: 'Pérdida de par (stall) a duty bajo por fricción estática. Fluencia del tubo en el cabezal: obliga a recalibrar o a avanzar el tramo comprimido.',
      vivo: () => [
        ['ω motor', `${n(P().omega, 1)} rad/s  (${n(P().omega * 9.549, 0)} rpm)`],
        ['ω cabezal', `${n(P().omega / CFG.BOMBA.RELACION_REDUCTORA * 9.549, 2)} rpm`],
        ['Volumen por vuelta', `${n(P().mlPorRev, 3)} mL/rev`],
        ['Caudal desplazado', `${n(P().caudalBombaMlS * 60, 3)} mL/min`],
        ['Corriente', `${n(P().corriente, 3)} A`],
        ['Horas acumuladas', `${n(P().horasFuncionamiento, 3)} h`],
        ['Pérdida por fluencia', `${n(CFG.BOMBA.FLUENCIA_POR_HORA * P().horasFuncionamiento * 100, 2)} %`]
      ]
    },

    tube: {
      nombre: 'Tubo de silicona 4 × 6 mm',
      ref: 'Silicona quirúrgica, grado alimentario',
      categoria: 'Hidráulica',
      cotas: 'Ø int 4.0 mm · Ø ext 6.0 mm · 1.5 m',
      especificaciones: [
        ['Diámetro interno NOMINAL', `${n(K().DIAMETRO_MM, 2)} mm  (lo que cree el firmware)`],
        ['Diámetro interno REAL', `${n(P().dRealMm, 2)} mm  (lo que mide de verdad)`],
        ['Tolerancia comercial', `±${CFG.TUBO.TOLERANCIA_MM} mm`],
        ['Área nominal', `${n(U.areaMm2(K().DIAMETRO_MM), 3)} mm²`],
        ['Área real', `${n(P().areaRealMm2, 3)} mm²`],
        ['Compliancia', `${(CFG.TUBO.COMPLIANCIA_M3_PA * 1e9).toFixed(3)} mL/kPa`],
        ['Resistencia (Hagen-Poiseuille)', 'R = 128·µ·L / (π·D⁴)']
      ],
      papel: 'Canaliza el fluido y, sobre todo, ALMACENA volumen al presurizarse. Esa compliancia es la que retrasa la alarma de oclusión y la que produce el bolo al liberarla.',
      incertidumbre: 'ES EL TÉRMINO DOMINANTE. Como Q ∝ D², se cumple u(Q)/Q = 2·u(D)/D. Con ±0.15 mm sobre 4 mm eso da 7.5 %, que POR SÍ SOLO excede el criterio de aceptación del 5 %. La solución correcta no es confiar en el diámetro nominal, sino calibrar el área efectiva contra la balanza.',
      fallo: 'Fluencia del elastómero en el cabezal. Adherencia de microburbujas a la pared interna. Acodamiento en los tramos no guiados.',
      vivo: () => {
        const err = (U.areaMm2(K().DIAMETRO_MM) / P().areaRealMm2 - 1) * 100;
        return [
          ['Presión de línea', `${n(SIM.Plant.presionMmHg(), 1)} mmHg`],
          ['Volumen almacenado', `${n(SIM.Plant.volumenAlmacenadoMl(), 4)} mL`],
          ['Velocidad media', `${n(P().velocidadMediaMmS, 2)} mm/s`],
          ['Reynolds', `${n(P().velocidadMediaMmS * 1e-3 * P().dRealMm * 1e-3 * P().fluido.rho / P().fluido.mu, 1)}`],
          ['Error por área nominal', `${n(err, 2)} %`]
        ];
      }
    },

    s1: {
      nombre: 'Sensor óptico 1 (D2 · INT0)',
      ref: 'LED IR 940 nm + fototransistor · LM393',
      categoria: 'Instrumentación',
      cotas: 'Cuerpo 10 × 6 × 12 mm · haz de 1.0 mm  [VERIFICAR]',
      especificaciones: [
        ['Principio', 'Interrupción del haz por discontinuidad de índice'],
        ['Longitud de onda', '940 nm (infrarrojo cercano)'],
        ['Ancho efectivo del haz', `${CFG.SENSOR_OPTICO.ANCHO_HAZ_MM} mm`],
        ['Comparador', 'LM393 con histéresis por realimentación de 1 MΩ'],
        ['Salida', 'Digital a D2 — interrupción externa INT0'],
        ['Antirrebote en la ISR', `${K().MIN_INTERVALO_ISR_US} µs`],
        ['Jitter de detección', `±${(CFG.SENSOR_OPTICO.JITTER_REL * 100).toFixed(0)} % + ${CFG.SENSOR_OPTICO.JITTER_ABS_US} µs`]
      ],
      papel: 'Marca t₁, el instante en que el trazador entra en el tramo calibrado. El ANCHO del pulso sirve además para estimar el volumen de la burbuja y disparar la alarma de aire.',
      incertidumbre: 'Un haz ancho difumina el instante de cruce. Con 1 mm de haz y un trazador a 2.6 mm/s, el pulso dura 0.4 s: el centro se localiza bien, pero el flanco depende del umbral del comparador.',
      fallo: 'Disparos espurios por luz ambiente (los fluorescentes y el sol emiten en 940 nm). Rebote múltiple en las interfaces curvas del tapón de Taylor si falta histéresis.',
      vivo: () => [
        ['Nivel de D2', H().pines.D2 ? 'HIGH (líquido)' : 'LOW (aire en el haz)'],
        ['Obstrucción del haz', `${n(H().obstruccion.s1 * 100, 0)} %`],
        ['t₁ registrado', `${(SIM.Firmware.st.ultimaMedida_us / 1e6).toFixed(3)} s`],
        ['Posición sobre el tubo', `s = ${n(SIM.Plant.S_SENSOR_1, 1)} mm`]
      ]
    },

    s2: {
      nombre: 'Sensor óptico 2 (D3 · INT1)',
      ref: 'LED IR 940 nm + fototransistor · LM393',
      categoria: 'Instrumentación',
      cotas: 'Cuerpo 10 × 6 × 12 mm · haz de 1.0 mm  [VERIFICAR]',
      especificaciones: [
        ['Principio', 'Interrupción del haz por discontinuidad de índice'],
        ['Ancho efectivo del haz', `${CFG.SENSOR_OPTICO.ANCHO_HAZ_MM} mm`],
        ['Salida', 'Digital a D3 — interrupción externa INT1'],
        ['Distancia NOMINAL a S1', `${n(K().DISTANCIA_MM, 2)} mm`],
        ['Distancia REAL a S1', `${n(SIM.Plant.D_REAL_SENSORES, 2)} mm`],
        ['Montaje', 'Raíl de aluminio 20×20 ranurado, no MDF']
      ],
      papel: 'Marca t₂ y cierra la medida de tiempo de vuelo: V = d/Δt.',
      incertidumbre: 'La diferencia entre la distancia NOMINAL programada y la REAL del montaje se traslada íntegra al caudal calculado. Sobre MDF la repetibilidad del utillaje es de ±0.5 mm, no de ±0.05 mm.',
      fallo: 'Desplazamiento del punto focal al reapretar el soporte. Deriva del raíl con la humedad si el material es MDF.',
      vivo: () => {
        const errD = (K().DISTANCIA_MM / SIM.Plant.D_REAL_SENSORES - 1) * 100;
        return [
          ['Nivel de D3', H().pines.D3 ? 'HIGH (líquido)' : 'LOW (aire en el haz)'],
          ['Obstrucción del haz', `${n(H().obstruccion.s2 * 100, 0)} %`],
          ['Δt de la última medida', `${n(F().deltaT_s, 4)} s`],
          ['Error por distancia nominal', `${n(errD, 2)} %`]
        ];
      }
    },

    hall: {
      nombre: 'Caudalímetro de turbina YF-S401',
      ref: 'Rotor magnético + sensor de efecto Hall',
      categoria: 'Instrumentación',
      cotas: '≈58 mm de largo · boquilla de espiga 7 mm  [VERIFICAR]',
      especificaciones: [
        ['Principio', 'Turbina con 4 imanes y sensor Hall'],
        ['Rango nominal', `${CFG.HALL.Q_NOMINAL_MIN_ML_MIN} – ${CFG.HALL.Q_NOMINAL_MAX_ML_MIN} mL/min`],
        ['Caudal de arranque', `≈${CFG.HALL.Q_ARRANQUE_ML_MIN} mL/min  ← POR DEBAJO NO GIRA`],
        ['Factor K', `F(Hz) = 98·Q(L/min) → ${CFG.HALL.K_PULSOS_POR_ML} pulsos/mL  [DATASHEET]`],
        ['Salida', 'Colector abierto → requiere pull-up de 4.7 kΩ a 5 V'],
        ['Linealidad', 'Se degrada cerca del umbral inferior del rango']
      ],
      papel: 'Alternativa al método óptico. Su gran ventaja es que entrega medida CONTINUA (ventana de 1 s), frente a los segundos o decenas de segundos del tiempo de vuelo: por eso el lazo cerrado funciona mucho mejor con turbina.',
      incertidumbre: 'El factor K debe determinarse experimentalmente; el valor de catálogo puede desviarse más del 10 % en el extremo bajo del rango.',
      fallo: 'NO ARRANCA a caudales clínicos. La guía §1.3 lo advierte: por debajo de 200–300 mL/min la inercia del rotor y la fricción de los rodamientos lo mantienen parado. Todo el régimen de infusión real queda fuera de su alcance.',
      vivo: () => [
        ['Estado del rotor', H().hall.girando ? 'GIRANDO' : 'PARADO (por debajo del arranque)'],
        ['Caudal actual', `${n(P().caudalSalidaMlS * 60, 2)} mL/min`],
        ['Pulsos acumulados', `${H().hall.pulsos}`],
        ['Velocidad del rotor', `${n(H().hall.rpm, 0)} rpm`]
      ]
    },

    beakerIn: {
      nombre: 'Depósito de entrada',
      ref: 'Vaso de precipitados de 500 mL',
      categoria: 'Hidráulica',
      cotas: 'Ø80 × 110 mm  [VERIFICAR]',
      especificaciones: [
        ['Capacidad', '500 mL, forma baja (Griffin)'],
        ['Fluido', `${P().fluido.nombre}`],
        ['Densidad', `${n(P().fluido.rho / 1000, 4)} g/mL @20 °C`],
        ['Viscosidad dinámica', `${(P().fluido.mu * 1000).toFixed(3)} mPa·s`],
        ['Altura de succión', 'Verificar con la bomba y el tubo seleccionados']
      ],
      papel: 'Reservorio sobre celda de carga. La toma permanece sumergida; el tubo debe quedar holgado para no aplicar fuerzas a la báscula.',
      incertidumbre: 'La densidad del fluido entra directamente en la conversión masa→volumen de la validación gravimétrica. Confundir agua (0.9982 g/mL) con salina al 0.9 % (1.0046 g/mL) introduce un sesgo del 0.6 %.',
      fallo: 'Descebado si el nivel baja por debajo de la toma. Entrada de aire por el racor de succión.',
      vivo: () => [
        ['Fluido cargado', P().fluido.nombre],
        ['Volumen extraído', `${n(CFG.GRAVIMETRIA.VOLUMEN_INICIAL_ML - P().depositoMl, 2)} mL`],
        ['Densidad aplicada', `${n(P().fluido.rho / 1000, 4)} g/mL`]
      ]
    },

    beakerOut: {
      nombre: 'Vaso colector',
      ref: 'Vaso graduado de 250 mL',
      categoria: 'Metrología',
      cotas: 'Ø70 × 95 mm  [VERIFICAR]',
      especificaciones: [
        ['Capacidad', '250 mL'],
        ['Uso', 'Recipiente de la validación gravimétrica'],
        ['Requisito', 'Boca estrecha o tapa para limitar la evaporación']
      ],
      papel: 'Recoge el fluido entregado. La masa que acumula es el PATRÓN contra el que se contrasta el caudal aspirado por pérdida de peso.',
      incertidumbre: 'La evaporación en vaso abierto resta entre 0.1 y 0.5 g/h, lo que en una corrida larga a caudal bajo es un sesgo apreciable.',
      fallo: 'Salpicadura al caer el chorro desde altura: parte de la masa no llega al vaso.',
      vivo: () => [
        ['Volumen de líquido', `${n(P().liquidoEntregadoMl, 3)} mL`],
        ['Volumen de aire recibido', `${n(P().aireEntregadoMl, 3)} mL`],
        ['Volumen total desplazado', `${n(P().desplazadoMl, 3)} mL`]
      ]
    },

    scale: {
      nombre: 'Balanza de precisión',
      ref: 'Resolución 0.01 g',
      categoria: 'Metrología',
      cotas: 'Plato 130 × 130 mm  [VERIFICAR]',
      especificaciones: [
        ['Resolución', `${CFG.BALANZA.RESOLUCION_G} g`],
        ['Repetibilidad', `σ ≈ ${CFG.BALANZA.RUIDO_SIGMA_G} g`],
        ['Deriva por evaporación', `${CFG.BALANZA.EVAPORACION_G_H} g/h`],
        ['Corrección por empuje del aire', `${(CFG.BALANZA.CORRECCION_EMPUJE * 100).toFixed(2)} %`]
      ],
      papel: 'Es el PATRÓN de la práctica. Todo lo demás se contrasta contra ella, no al revés.',
      incertidumbre: 'Aporta la referencia de menor incertidumbre del banco (0.01 g sobre decenas de gramos ≈ 0.05 %). Por eso conviene calibrar el área efectiva del tubo CONTRA la balanza, en lugar de confiar en el diámetro nominal.',
      fallo: 'Deriva térmica y corrientes de aire. Vibración transmitida desde la bomba si comparten mesa sin amortiguación.',
      vivo: () => [
        ['Masa indicada', `${P().masaIndicadaG.toFixed(2)} g`],
        ['Masa real (verdad del modelo)', `${n(P().masaRealG, 4)} g`],
        ['Evaporado acumulado', `${n(P().evaporadoG, 3)} g`],
        ['Volumen gravimétrico', `${n(P().masaIndicadaG / (P().fluido.rho / 1000), 3)} mL`]
      ]
    },

    psu: {
      nombre: 'Fuente conmutada 12 V',
      ref: '12 V DC · 2 A regulada',
      categoria: 'Potencia',
      cotas: '60 × 40 × 30 mm  [VERIFICAR]',
      especificaciones: [
        ['Tensión nominal', `${CFG.ALIMENTACION.V_NOMINAL} V`],
        ['Corriente', '2 A'],
        ['Resistencia interna modelada', `${CFG.ALIMENTACION.R_INTERNA} Ω`],
        ['Rizado', `≈${(CFG.ALIMENTACION.RIZADO_V * 1000).toFixed(0)} mV`]
      ],
      papel: 'Alimenta exclusivamente la etapa de potencia. La masa se une a la del Arduino en un solo punto.',
      incertidumbre: 'Su caída bajo carga modifica la tensión que llega al motor, lo que desplaza la curva duty→caudal. Es una de las razones por las que el feedforward solo nunca basta.',
      fallo: 'Si el Arduino se alimenta desde el regulador de 5 V del L298N, el ruido de conmutación del motor provoca reinicios del microcontrolador.',
      vivo: () => [
        ['Tensión en bornes', `${n(P().vSupply, 3)} V`],
        ['Corriente entregada', `${n(P().corriente, 3)} A`],
        ['Caída bajo carga', `${n(CFG.ALIMENTACION.V_NOMINAL - P().vSupply, 3)} V`]
      ]
    },

    yport: {
      nombre: 'Puerto en Y / llave de 3 vías',
      ref: 'Conector luer-lock',
      categoria: 'Hidráulica',
      cotas: 'Cuerpo 30 mm · luer estándar',
      especificaciones: [
        ['Función', 'Inyección del trazador con jeringa de insulina'],
        ['Volumen del trazador', `${CFG.TRAZADOR.VOLUMEN_ML} mL`],
        ['Longitud del tapón resultante', `${n(CFG.TRAZADOR.VOLUMEN_ML * 1000 / P().areaRealMm2, 2)} mm`],
        ['Relación L/D', `${n(CFG.TRAZADOR.VOLUMEN_ML * 1000 / P().areaRealMm2 / P().dRealMm, 2)}`]
      ],
      papel: 'Introduce la discontinuidad óptica que los sensores necesitan. Sin ella, un tubo lleno de agua limpia no produce ninguna interrupción de haz: es la limitación que señala la guía §1.2.',
      incertidumbre: 'El tamaño del trazador determina su factor de perfil: un tapón de Taylor viaja cerca de la velocidad media; una burbuja pequeña, no.',
      fallo: 'CLÍNICAMENTE INADMISIBLE. Inyectar aire en una línea de infusión real es exactamente lo que la alarma de aire debe impedir. Este puerto solo tiene sentido en un banco de laboratorio con agua y vaso colector.',
      vivo: () => [
        ['Trazadores en vuelo', `${P().trazadores.length}`],
        ['Aire entregado', `${n(P().aireEntregadoMl, 3)} mL`],
        ['Aire en ventana de 1 h', `${n(F().aireAcumuladoMl, 3)} mL`],
        ['Último bolo de aire', `${n(F().aireBoloUl, 1)} µL`]
      ]
    },

    rail: {
      nombre: 'Raíl de instrumentación',
      ref: 'Perfil de aluminio 20×20 ranurado',
      categoria: 'Estructura',
      cotas: '20 × 20 × 260 mm',
      especificaciones: [
        ['Material', 'Aluminio extruido anodizado, ranura en T'],
        ['Repetibilidad de fijación', '±0.05 mm'],
        ['Alternativa desaconsejada', 'MDF: ±0.5 mm y deriva con la humedad'],
        ['Orientación del tramo', 'VERTICAL, flujo ascendente']
      ],
      papel: 'Sostiene los dos sensores a una distancia estable y repetible. Es la pieza de la que depende la incertidumbre geométrica de todo el banco.',
      incertidumbre: 'Un pie de rey resuelve 0.02 mm, pero la incertidumbre real la fija el UTILLAJE, no el instrumento de medida. Sobre madera no es posible sostener ±0.05 mm.',
      fallo: 'Deriva dimensional con la humedad y la temperatura si el material no es metálico.',
      vivo: () => [
        ['Distancia real S1–S2', `${n(SIM.Plant.D_REAL_SENSORES, 3)} mm`],
        ['Distancia programada', `${n(K().DISTANCIA_MM, 3)} mm`],
        ['Orientación del tramo', SIM.Plant.Path.esVertical(SIM.Plant.S_SENSOR_1) ? 'VERTICAL ✓' : 'HORIZONTAL ✗']
      ]
    },

    checkvalve: {
      nombre: 'Válvula antirretorno',
      ref: 'Check plástica unidireccional de 4 mm',
      categoria: 'Hidráulica',
      cotas: 'Ø8 × 30 mm  [VERIFICAR]',
      especificaciones: [
        ['Tipo', 'Bola o diafragma, unidireccional'],
        ['Presión de apertura', '≈2 – 10 kPa  [VERIFICAR]'],
        ['Posición', 'Antes del depósito colector']
      ],
      papel: 'Impide el sifón retrógrado y el descebado del circuito cuando la bomba se detiene.',
      incertidumbre: 'Su presión de apertura se suma a la carga que debe vencer la bomba, desplazando ligeramente la curva duty→caudal.',
      fallo: 'Pegado por depósitos o por burbujas atrapadas en el asiento.',
      vivo: () => [
        ['Presión de línea', `${n(SIM.Plant.presionMmHg(), 1)} mmHg`],
        ['Caudal de paso', `${n(P().caudalSalidaMlS * 60, 3)} mL/min`]
      ]
    }
  };
})();
