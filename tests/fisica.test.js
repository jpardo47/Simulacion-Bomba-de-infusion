/* Banco de pruebas headless del modelo físico. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'src');
const sandbox = { console, Math, Date, performance: { now: () => Date.now() } };
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const f of ['config.js', 'plant.js', 'hardware.js', 'firmware.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const SIM = sandbox.SIM;
const { Plant, Hardware, Firmware, CFG } = SIM;
Firmware.setSensor('optico'); // Regresiones del método histórico.
const DT = CFG.FIXED_DT;

const eventos = [];
SIM.bus.on('alarma', d => eventos.push(`ALARMA ${d.clave} ${d.activa ? 'ON' : 'off'}`));
SIM.bus.on('medida', d => eventos.push(
  `MEDIDA dt=${d.deltaT.toFixed(4)}s V=${d.vel.toFixed(2)}mm/s Q=${d.q.toFixed(3)}mL/min periodo=${d.periodoLazo.toFixed(1)}s`));

let mando = { enaPwm: 0, in1: false, in2: false };
let tUs = 0, tSim = 0;

function paso() {
  Plant.step(DT, mando);
  const ev = Hardware.step(DT, tUs, Firmware.st.sensor);
  mando = Firmware.loop(DT, tUs, ev, Hardware.adcCuentas);
  tUs += DT * 1e6; tSim += DT;
}
function correr(seg) { const n = Math.round(seg / DT); for (let i = 0; i < n; i++) paso(); }

const ok = [], mal = [];
function chk(nombre, cond, detalle) {
  (cond ? ok : mal).push(`${cond ? 'OK  ' : 'FALLO'} ${nombre} — ${detalle}`);
}

console.log('═══ 1. GEOMETRÍA DE LA TRAYECTORIA ═══');
console.log(`Longitud total del circuito : ${Plant.Path.total.toFixed(1)} mm`);
console.log(`s inyección                 : ${Plant.S_INYECCION.toFixed(1)} mm`);
console.log(`s sensor 1 / sensor 2       : ${Plant.S_SENSOR_1.toFixed(1)} / ${Plant.S_SENSOR_2.toFixed(1)} mm`);
console.log(`Distancia REAL entre haces  : ${Plant.D_REAL_SENSORES.toFixed(3)} mm  (nominal 100.000)`);
console.log(`Tramo de medida vertical    : ${Plant.Path.esVertical(Plant.S_SENSOR_1)} / ${Plant.Path.esVertical(Plant.S_SENSOR_2)}`);
console.log(`Volumen por vuelta          : ${Plant.st.mlPorRev.toFixed(4)} mL/rev`);
chk('tramo de medida vertical', Plant.Path.esVertical(Plant.S_SENSOR_1) && Plant.Path.esVertical(Plant.S_SENSOR_2), 'ambos sensores en el montante');
chk('distancia entre haces ~100 mm', Math.abs(Plant.D_REAL_SENSORES - 100) < 12, `${Plant.D_REAL_SENSORES.toFixed(2)} mm`);

console.log('\n═══ 2. CURVA PWM → CAUDAL (zona muerta emergente) ═══');
const curva = [];
for (const pwm of [20, 30, 35, 40, 45, 50, 54, 60, 80, 120, 180, 255]) {
  Plant.st.depositoMl = CFG.GRAVIMETRIA.VOLUMEN_INICIAL_ML;
  Plant.st.omega = 0; Plant.st.presionPa = 0; Plant.reiniciarDesgaste();
  const m = { enaPwm: pwm, in1: true, in2: false };
  for (let i = 0; i < 6000; i++) Plant.step(DT, m);   // 6 s hasta régimen
  const q = Plant.st.caudalSalidaMlS * 60;
  curva.push([pwm, q]);
  console.log(`  PWM ${String(pwm).padStart(3)} → ${q.toFixed(3).padStart(8)} mL/min = ${(q * 60).toFixed(1).padStart(8)} mL/h   I=${Plant.st.corriente.toFixed(3)} A`);
}
const qMax = curva[curva.length - 1][1];
const zonaMuerta = curva.find(c => c[1] > 0.001);
chk('existe zona muerta emergente', curva[0][1] < 1e-6, `PWM 20 no mueve la bomba; arranca cerca de PWM ${zonaMuerta[0]}`);
chk('caudal máximo razonable', qMax > 20 && qMax < 80, `${qMax.toFixed(1)} mL/min a PWM 255`);

console.log('\n═══ 3. RESOLUCIÓN DE 1 LSB DE PWM (hallazgo P0-5) ═══');
function qDePwm(pwm) {
  Plant.st.depositoMl = CFG.GRAVIMETRIA.VOLUMEN_INICIAL_ML;
  Plant.st.omega = 0; Plant.st.presionPa = 0; Plant.reiniciarDesgaste();
  const m = { enaPwm: pwm, in1: true, in2: false };
  for (let i = 0; i < 6000; i++) Plant.step(DT, m);
  return Plant.st.caudalSalidaMlS * 3600;   // mL/h
}
for (const sp of [120, 250, 600]) {
  let mejor = 0, mejorD = 1e9;
  for (let p = 30; p <= 255; p++) {
    const q = qDePwm(p);
    if (Math.abs(q - sp) < mejorD) { mejorD = Math.abs(q - sp); mejor = p; }
  }
  // La fuente tiene rizado: una sola medida del LSB es ruidosa. Se promedia.
  let acc = 0; const REP = 7;
  for (let r = 0; r < REP; r++) acc += Math.abs(qDePwm(mejor + 1) - qDePwm(mejor));
  const lsb = acc / REP;
  console.log(`  Consigna ${String(sp).padStart(4)} mL/h → PWM ${mejor}; 1 LSB = ${lsb.toFixed(2)} mL/h = ${(lsb / sp * 100).toFixed(1)} % de la consigna`);
  if (sp === 120) chk('a 120 mL/h la cuantización supera el 5 %', (lsb / sp * 100) > 5,
    `1 LSB = ${(lsb / sp * 100).toFixed(1)} % — el criterio del 5 % es inalcanzable solo por el actuador`);
}

console.log('\n═══ 4. INFUSIÓN CON TRAZADOR Y LAZO CERRADO ═══');
Plant.purgar(); Plant.tararBalanza(); Plant.st.omega = 0; Plant.reiniciarDesgaste();
Hardware.reset(); Firmware.rearmar(); Firmware.resetVolumen();
Firmware.setSetpoint(600);           // caudal alto para que el tránsito sea corto
Firmware.setLazoCerrado(true);
Firmware.setModoBanco(true);         // práctica de laboratorio: trazador permitido
Firmware.start();
correr(4);
Plant.inyectarTrazador(0.05);
correr(70);
console.log(`  Caudal real          : ${(Plant.st.caudalSalidaMlS * 60).toFixed(3)} mL/min`);
console.log(`  Velocidad media      : ${Plant.st.velocidadMediaMmS.toFixed(3)} mm/s`);
console.log(`  PWM                  : ${Firmware.st.pwm}`);
console.log(`  Δt medido            : ${Firmware.st.deltaT_s.toFixed(4)} s`);
console.log(`  V medida por ToF     : ${Firmware.st.vMedidaMmS.toFixed(3)} mm/s`);
console.log(`  Q óptico             : ${Firmware.st.qMedidaMlMin.toFixed(4)} mL/min`);
console.log(`  Masa en balanza      : ${Plant.st.masaIndicadaG.toFixed(2)} g`);
console.log(`  Aire entregado       : ${Plant.st.aireEntregadoMl.toFixed(3)} mL`);
const errMet = Math.abs(Firmware.st.qMedidaMlMin - Plant.st.caudalSalidaMlS * 60) / (Plant.st.caudalSalidaMlS * 60) * 100;
console.log(`  Error ToF vs real    : ${errMet.toFixed(2)} %`);
chk('el ToF produce una medida', Firmware.st.deltaT_s > 0, `Δt = ${Firmware.st.deltaT_s.toFixed(4)} s`);
chk('el error metrológico NO es cero', errMet > 0.2,
  `${errMet.toFixed(2)} % — la burbuja no viaja a la velocidad media y las constantes nominales no son las reales`);
chk('el aire se descuenta de la balanza', Plant.st.aireEntregadoMl > 0 &&
  Plant.st.liquidoEntregadoMl < Plant.st.desplazadoMl,
  `desplazado ${Plant.st.desplazadoMl.toFixed(2)} mL, líquido ${Plant.st.liquidoEntregadoMl.toFixed(2)} mL`);

console.log('\n═══ 5. OCLUSIÓN: PRESIÓN, ALARMA Y BOLO POST-OCLUSIÓN ═══');
Plant.purgar(); Plant.tararBalanza();
Firmware.rearmar(); Firmware.resetVolumen();
Firmware.setSetpoint(600); Firmware.start();
correr(12);                          // margen para que aprenda la corriente basal
const iBasal = Plant.st.corriente;
console.log(`  Corriente basal      : ${iBasal.toFixed(4)} A`);
Plant.setOclusion(true);
let tAlarma = null, pAlarma = null, iAlarma = null, iPico = 0;
for (let i = 0; i < 60000; i++) {
  paso();
  iPico = Math.max(iPico, Plant.st.corriente);
  if (!tAlarma && Firmware.st.alarmas.OCLUSION.activa) {
    tAlarma = i * DT; pAlarma = Plant.presionMmHg(); iAlarma = Plant.st.corriente;
  }
}
console.log(`  Presión tras 60 s    : ${Plant.presionMmHg().toFixed(1)} mmHg`);
console.log(`  Corriente al alarmar : ${iAlarma !== null ? iAlarma.toFixed(4) : '—'} A  (×${iAlarma !== null ? (iAlarma / iBasal).toFixed(2) : '—'})`);
console.log(`  Corriente de pico    : ${iPico.toFixed(4)} A  (×${(iPico / iBasal).toFixed(2)})`);
console.log(`  Alarma de oclusión   : ${tAlarma !== null ? `a los ${tAlarma.toFixed(1)} s, con ${pAlarma.toFixed(0)} mmHg` : 'NO DISPARÓ'}`);
console.log(`  Corte fail-safe      : ENA=${Firmware.st.pwm}, IN1=${Firmware.st.in1}, IN2=${Firmware.st.in2}`);
const boloAlmacenado = Plant.volumenAlmacenadoMl();
console.log(`  Volumen en compliancia: ${boloAlmacenado.toFixed(4)} mL  ← saldrá como BOLO al liberar`);
chk('la oclusión sube la presión', Plant.presionMmHg() > 100, `${Plant.presionMmHg().toFixed(0)} mmHg`);
chk('la corriente delata la oclusión', iAlarma !== null && iAlarma / iBasal > 1.2, `×${iAlarma !== null ? (iAlarma / iBasal).toFixed(2) : '0'} en el instante de la alarma`);
chk('la alarma de oclusión dispara', tAlarma !== null, tAlarma !== null ? `${tAlarma.toFixed(1)} s` : 'no disparó');
chk('corte fail-safe efectivo', Firmware.st.pwm === 0 && !Firmware.st.in1 && !Firmware.st.in2, 'ENA=0, IN1=LOW, IN2=LOW');
chk('hay bolo post-oclusión almacenado', boloAlmacenado > 0.01, `${boloAlmacenado.toFixed(4)} mL`);

// Liberar y medir el bolo
const volAntes = Plant.st.desplazadoMl;
Plant.setOclusion(false);
correr(3);
console.log(`  Volumen liberado en 3 s: ${(Plant.st.desplazadoMl - volAntes).toFixed(4)} mL`);

console.log('\n═══ 6. AIRE EN LÍNEA: MODO CLÍNICO vs MODO BANCO ═══');
Plant.purgar(); Plant.tararBalanza();
Firmware.rearmar(); Firmware.resetVolumen();
Firmware.setModoBanco(false);        // MODO CLÍNICO: inyectar aire es una falta grave
Firmware.setSetpoint(600); Firmware.start();
correr(4);
Plant.inyectarTrazador(0.05); correr(40);
const aireClinico = Firmware.st.alarmas.AIRE_EN_LINEA.activa;
const pwmClinico = Firmware.st.pwm;
console.log(`  [CLÍNICO] bolo medido : ${Firmware.st.aireBoloUl.toFixed(1)} µL (umbral ${CFG.ALARMAS.AIRE_BOLO_UL} µL)`);
console.log(`  [CLÍNICO] alarma      : ${aireClinico ? 'ACTIVA' : 'inactiva'}`);
console.log(`  [CLÍNICO] bomba       : ENA=${pwmClinico}, modo=${Firmware.st.modo}`);
chk('en modo clínico el trazador dispara la alarma de aire y detiene la bomba',
  aireClinico && pwmClinico === 0,
  'el método de medida del banco es incompatible con el uso clínico — ése es el hallazgo didáctico');

Firmware.setModoBanco(true); Firmware.rearmar(); Plant.purgar();
Firmware.start(); correr(4);
Plant.inyectarTrazador(0.05); correr(40);
console.log(`  [BANCO]   bolo medido : ${Firmware.st.aireBoloUl.toFixed(1)} µL`);
console.log(`  [BANCO]   alarma      : ${Firmware.st.alarmas.AIRE_EN_LINEA.activa ? 'ACTIVA' : 'inhibida'}`);
console.log(`  [BANCO]   bomba       : ENA=${Firmware.st.pwm}, modo=${Firmware.st.modo}`);
chk('en modo banco el aire se mide pero no detiene la bomba',
  !Firmware.st.alarmas.AIRE_EN_LINEA.activa && Firmware.st.aireBoloUl > 0 && Firmware.st.pwm > 0,
  'la práctica de tiempo de vuelo es posible sin desarmar la seguridad clínica');

console.log('\n═══ 7. TURBINA HALL POR DEBAJO DEL ARRANQUE ═══');
Plant.purgar(); Firmware.rearmar(); Firmware.resetVolumen();
Firmware.setSensor('hall'); Firmware.setSetpoint(600); Firmware.start();
correr(6);
console.log(`  Caudal               : ${(Plant.st.caudalSalidaMlS * 60).toFixed(2)} mL/min (arranque: ${CFG.HALL.Q_ARRANQUE_ML_MIN})`);
console.log(`  Rotor                : ${Hardware.hall.girando ? 'GIRANDO' : 'PARADO'}`);
console.log(`  Pulsos               : ${Hardware.hall.pulsos}`);
console.log(`  Alarma turbina       : ${Firmware.st.alarmas.TURBINA_PARADA.activa ? 'ACTIVA' : 'inactiva'}`);
chk('la turbina NO gira a caudal clínico', !Hardware.hall.girando && Hardware.hall.pulsos === 0,
  'coincide con la guía §1.3: el YF-S401 no sirve para microcaudal');

console.log('\n═══ 8. ESTABILIDAD NUMÉRICA ═══');
Firmware.setSensor('optico'); Firmware.setModoBanco(true);
Plant.purgar(); Firmware.rearmar(); Firmware.setSetpoint(300); Firmware.start();
let finito = true;
for (let i = 0; i < 120000; i++) {
  paso();
  if (!isFinite(Plant.st.omega) || !isFinite(Plant.st.presionPa) || !isFinite(Plant.st.caudalSalidaMlS)) { finito = false; break; }
}
console.log(`  120 s de simulación    : ${finito ? 'todos los estados finitos' : 'DIVERGIÓ'}`);
console.log(`  ω = ${Plant.st.omega.toFixed(2)} rad/s, P = ${Plant.presionMmHg().toFixed(1)} mmHg, Q = ${(Plant.st.caudalSalidaMlS * 60).toFixed(3)} mL/min`);
chk('el integrador no diverge', finito, '120 000 pasos a 1 kHz sin NaN ni infinitos');

console.log('\n═══ EVENTOS REGISTRADOS (últimos 12) ═══');
eventos.slice(-12).forEach(e => console.log('  ' + e));

console.log('\n═══ RESUMEN ═══');
ok.forEach(l => console.log('  ' + l));
mal.forEach(l => console.log('  ' + l));
console.log(`\n  ${ok.length} comprobaciones superadas, ${mal.length} fallidas.`);
process.exit(mal.length ? 1 : 0);
