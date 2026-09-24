const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
function banco(){const s={Math:Object.create(Math),console};s.window=s;let seed=71;s.Math.random=()=>((seed=(1664525*seed+1013904223)>>>0)/4294967296);vm.createContext(s);for(const f of ['config','plant','hardware','firmware'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src',f+'.js'),'utf8'),s);return s.SIM;}
{
 const {Firmware:F}=banco(); F.start();
 for(let i=1;i<=350;i++){const t=i*.1;F.loop(.1,t*1e6,[{hx711:true,masaG:300-120/3600*.9982*t,tUs:t*1e6}],0);if(t<29)assert.equal(F.st.medidaValida,false);}
 assert.ok(F.st.medidaValida);assert.ok(Math.abs(F.st.qMedidaMlMin*60-120)<1e-6);
 F.loop(.1,38e6,[],0);assert.ok(F.st.alarmas.PESO_SIN_DATOS.activa);assert.equal(F.st.pwm,0);
 console.log('OK pendiente de masa independiente de la planta; ventana de 30 s y corte por desconexión.');
}
{
 const {Plant:P,Hardware:H,Firmware:F}=banco();F.start();let cmd={enaPwm:0,in1:false,in2:false};
 const inicial=P.st.depositoMl;
 for(let i=1;i<=600000;i++){P.step(.001,cmd);cmd=F.loop(.001,i*1000,H.step(.001,i*1000,'gravimetrico'),H.adcCuentas);assert.ok(!F.hayCorte(),`alarma a ${i/1000}s`);}
 assert.ok(F.st.medidaValida);assert.equal(P.st.trazadores.length,0);assert.ok(P.st.depositoMl<inicial);assert.ok(P.st.liquidoEntregadoMl>0);
 assert.ok(Math.abs(F.st.qMedidaMlMin*60-120)<20);
 const deposito=P.st.depositoMl;P.tararBalanza();assert.equal(P.st.depositoMl,deposito);
 console.log(`OK 600 s sin trazadores: caudal HX711=${(F.st.qMedidaMlMin*60).toFixed(2)} mL/h, depósito=${deposito.toFixed(2)} mL; tara no repone origen.`);
 F.stop();P.vaciarParaCebado();F.start();const recolectado=P.st.desplazadoMl;
 for(let i=600001;i<=602000;i++){P.step(.001,cmd);cmd=F.loop(.001,i*1000,H.step(.001,i*1000,'gravimetrico'),H.adcCuentas);}
 assert.equal(P.st.desplazadoMl,recolectado);assert.ok(P.st.depositoMl<deposito);
 console.log('OK durante cebado se aspira desde origen pero aún no aumenta el colector.');
}
{
 const {Plant:P,Hardware:H,Firmware:F}=banco();P.st.depositoMl=3;F.start();let cmd={enaPwm:0,in1:false,in2:false};
 for(let i=1;i<=200;i++){P.step(.001,cmd);cmd=F.loop(.001,i*1000,H.step(.001,i*1000,'gravimetrico'),H.adcCuentas);}
 assert.ok(F.st.alarmas.DEPOSITO_VACIO.activa);assert.equal(F.st.pwm,0);assert.ok(P.st.depositoMl>=0);
 console.log('OK reserva de depósito: alarma y motor detenido antes de agotar el líquido.');
}
