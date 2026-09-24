const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
function banco() {
  const s = { Math: Object.create(Math), console }; s.window = s;
  let seed = 184;
  s.Math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  vm.createContext(s);
  for (const f of ['config', 'plant', 'hardware', 'firmware']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f + '.js'), 'utf8'), s);
  return s.SIM;
}
{
  const {Plant:P} = banco();
  P.vaciarParaCebado();
  const inicio = P.st.frenteS;
  let transportado = 0;
  for (let i = 0; i < 2000; i++) {
    P.step(.001, {enaPwm:100, in1:true, in2:false});
    transportado += P.st.caudalSalidaMlS * .001;
  }
  assert.ok(P.st.frenteS > inicio && P.st.frenteS < P.Path.total);
  assert.equal(P.st.desplazadoMl, 0); assert.equal(P.st.liquidoEntregadoMl,0); assert.equal(P.st.masaRealG,0);
  assert.equal(P.inyectarTrazador(.05),null);
  console.log('OK: el frente avanza; la balanza no recibe líquido antes de completar el cebado.');
  for (let i = 0; i < 60000; i++) {
    P.step(.001, {enaPwm:100, in1:true, in2:false});
    transportado += P.st.caudalSalidaMlS * .001;
  }
  assert.equal(P.st.frenteS,P.Path.total); assert.ok(P.st.masaRealG>0);
  const llenado = (P.Path.total-inicio)*P.st.areaRealMm2/1000;
  assert.ok(Math.abs(transportado-llenado-P.st.desplazadoMl)<1e-8);
  console.log('OK: conservación del volumen de transporte = llenado del tubo + colector.');
}
{
  const {Plant:P,Hardware:H,Firmware:F} = banco();
  F.setSensor("optico"); F.setSetpoint(120); F.start(); P.inyectarTrazador(.05);
  let cmd = {enaPwm:0,in1:false,in2:false};
  const flancos = [];
  for (let i = 1; i <= 110000; i++) {
    P.step(.001,cmd);
    const eventos = H.step(.001,i*1000,'optico');
    flancos.push(...eventos.filter(e=>e.obstruido));
    cmd=F.loop(.001,i*1000,eventos,H.adcCuentas);
  }
  assert.equal(H.detecciones.s1,1); assert.equal(H.detecciones.s2,1);
  assert.deepEqual(flancos.map(e=>e.pin),['D2','D3']);
  assert.ok(F.st.medidaValida); assert.ok(!F.hayCorte());
  const dt=(flancos[1].tUs-flancos[0].tUs)/1e6;
  assert.ok(Math.abs(F.st.deltaT_s-dt)<1e-9);
  assert.ok(Math.abs(F.st.vMedidaMmS-F.konst.DISTANCIA_MM/dt)<1e-9);
  assert.ok(P.st.recorridoFlujoMm>0 && P.st.liquidoEntregadoMl>0);
  console.log(`OK: START a 120 mL/h → S1 → S2 → medida: Δt=${dt.toFixed(2)} s, v=${F.st.vMedidaMmS.toFixed(2)} mm/s; colector=${P.st.liquidoEntregadoMl.toFixed(3)} mL.`);
  F.stop();
  for(let i=0;i<3000;i++) P.step(.001,{enaPwm:0,in1:false,in2:false});
  const s = P.st.recorridoFlujoMm;
  for(let i=0;i<1000;i++) P.step(.001,{enaPwm:0,in1:false,in2:false});
  assert.ok(Math.abs(P.st.recorridoFlujoMm-s)<1e-6);
  console.log('OK: tras la parada mecánica también se detienen las marcas del líquido.');
}
{
  const {Plant:P,Hardware:H,Firmware:F,CFG} = banco();
  F.setSensor("optico"); F.setSetpoint(120); F.start(); P.inyectarTrazador(.05);
  let cmd = {enaPwm:0,in1:false,in2:false}, ultimo=0, medidas=0;
  // Misma política que la UI: no solapar trazadores dentro del tramo de medida.
  for (let i=1;i<=600000;i++) {
    P.step(.001,cmd);
    cmd=F.loop(.001,i*1000,H.step(.001,i*1000,'optico'),H.adcCuentas);
    const activo=P.st.trazadores.some(t=>t.s-t.longitudMm<P.S_SENSOR_2+CFG.SENSOR_OPTICO.ANCHO_HAZ_MM);
    if(!activo && i-ultimo>CFG.TRAZADOR.INTERVALO_AUTO_MS) { P.inyectarTrazador(.05); ultimo=i; }
    if (F.st.ultimaMedida_us > medidas) medidas=F.st.ultimaMedida_us;
    assert.equal(F.hayCorte(),false,`alarma inesperada a ${i/1000} s`);
  }
  assert.ok(H.detecciones.s2>=5); assert.ok(F.st.pwm>0); assert.ok(F.st.ultimaMedida_us>450e6);
  console.log(`OK: 600 s a 120 mL/h con ${H.detecciones.s2} tránsitos S1/S2, sin falso timeout y bomba activa.`);
}
