const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function banco() {
  const s = { console, Math: Object.create(Math) }; s.window = s;
  let seed = 42;
  s.Math.random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  vm.createContext(s);
  for (const f of ['config','plant','hardware','firmware']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../src', f+'.js'),'utf8'),s);
  return s.SIM;
}
let count = 0;
function test(name, fn) { fn(banco()); count++; console.log('OK ' + name); }
test('entradas inválidas no contaminan estados ni constantes', ({Firmware:F,Plant:P,CFG}) => {
  const rate = F.st.setpointMlH, d = P.st.dRealMm, nominal = F.konst.DIAMETRO_MM;
  for (const x of [NaN, Infinity, -Infinity]) {
    F.setSetpoint(x); F.setDiametroNominal(x); F.setDistanciaNominal(x); F.setKp(x); F.setKi(x); P.setDiametroReal(x);
  }
  F.setDiametroNominal(-1); F.setDistanciaNominal(0); F.setVtbi(-2);
  assert.equal(F.st.setpointMlH,rate); assert.equal(P.st.dRealMm,d);
  assert.equal(F.konst.DIAMETRO_MM,nominal); assert.ok(F.konst.DISTANCIA_MM > 0);
  assert.ok(Number.isFinite(CFG.CONTROL.KP)); assert.ok(F.st.vtbiMl > 0);
  P.setDiametroReal(12); assert.ok(P.st.dRealMm < CFG.TUBO.D_EXT_MM);
});
test('ganancias cero y límites de consigna', ({Firmware:F,CFG}) => {
  F.setKi(0); F.setKp(0); assert.equal(CFG.CONTROL.KI,0); assert.equal(CFG.CONTROL.KP,0);
  F.setSetpoint(9999); assert.equal(F.st.setpointMlH,CFG.INFUSION.RITMO_MAX_ML_H);
});
test('bolos y trazadores rechazan volúmenes inválidos', ({Firmware:F,Plant:P,CFG}) => {
  F.start();
  for (const x of [-1,0,NaN,Infinity]) { assert.equal(F.bolo(x,600),false); assert.equal(F.bolo(1,x),false); assert.equal(P.inyectarTrazador(x),null); }
  assert.equal(P.st.trazadores.length,0);
  assert.ok(F.bolo(2,9999)); assert.equal(F.st.bolo.velocidadMlH,CFG.BOLO.VELOCIDAD_MAX_ML_H);
});
test('STOP publica inmediatamente salidas a cero', ({Firmware:F}) => {
  F.start(); F.loop(.01,10000,[],0); assert.ok(F.st.pwm > 0);
  F.stop(); assert.equal(F.st.pwm,0); assert.equal(F.st.in1,false); assert.equal(F.st.in2,false);
});
test('VTBI cancela el bolo antes de entrar en KVO', ({Firmware:F}) => {
  F.setVtbi(1); F.start(); F.bolo(5,600); F.st.viMl=1;
  F.loop(.01,10000,[],0);
  assert.equal(F.st.modo,'KVO'); assert.equal(F.st.bolo.activo,false);
});
test('KVO con alarma corta motor y cambia a ALARMA', ({Firmware:F}) => {
  F.st.modo='KVO'; F.st.alarmas.OCLUSION.activa=true;
  assert.equal(F.bolo(2,600),false);
  const out=F.loop(.01,10000,[],0);
  assert.equal(F.st.modo,'ALARMA'); assert.equal(out.enaPwm,0); assert.equal(out.in1,false);
});
test('cambio de sensor elimina medida y corrección anteriores', ({Firmware:F}) => {
  F.st.medidaValida=true; F.st.correccion=30; F.st.ultimaMedida_us=5e6;
  F.st.alarmas.TURBINA_PARADA.activa=true;
  F.setSensor('optico'); assert.equal(F.st.medidaValida,false); assert.equal(F.st.correccion,0);
  assert.equal(F.st.ultimaMedida_us,0); assert.equal(F.st.alarmas.TURBINA_PARADA.activa,false);
});
test('la trayectoria pasa por el arco peristáltico y conserva los sensores', ({Plant:P}) => {
  const points=P.CONTROL_POINTS.slice(3,12);
  assert.equal(points.length,9);
  for (const [x,y,z] of points) { assert.ok(Math.abs(Math.hypot(x+85,y-40)-21)<1e-8); assert.equal(z,6); }
  assert.ok(P.Path.esVertical(P.S_SENSOR_1) && P.Path.esVertical(P.S_SENSOR_2));
  assert.ok(Math.abs(P.D_REAL_SENSORES-100)<3);
});
test('STOP descarta un tránsito parcial antes de reanudar tras una pausa larga', ({Firmware:F}) => {
  F.setSensor('optico');
  F.start();
  F.loop(.001, 1000000, [{pin:'D2',nivel:0,tUs:1000000}], 0);
  F.stop(); F.start();
  F.loop(.001, 200000000, [], 0);
  assert.equal(F.hayCorte(),false); assert.equal(F.st.modo,'INFUNDIENDO');
});
console.log(`${count} pruebas de regresión superadas.`);
