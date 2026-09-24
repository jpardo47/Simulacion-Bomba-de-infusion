/* Prueba de humo: ejecuta index.html completo con DOM y Three.js simulados.
   Objetivo: detectar errores de ejecución reales (referencias rotas, APIs mal
   usadas) sin necesidad de navegador. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const DIR = path.join(__dirname, '..');

/* ---------- DOM mínimo ---------- */
const V = () => ({ set(){return this;}, copy(){return this;}, clone(){return V();}, sub(){return this;},
  add(){return this;}, normalize(){return this;}, multiplyScalar(){return this;},
  lengthSq(){return 1;}, length(){return 50;}, x:0,y:0,z:0 });

class El {
  constructor(tag){ this.tagName=(tag||'div').toUpperCase(); this.children=[]; this.style={};
    this.dataset={}; this.classList={add(){},remove(){},contains(){return false;}};
    this._cls=''; this.textContent=''; this._html=''; this.checked=true; this.value='120';
    this.clientWidth=800; this.clientHeight=400; this.width=800; this.height=400;
    this.scrollTop=0; this.scrollHeight=100; this._lis={}; }
  get className(){return this._cls;} set className(v){this._cls=v;}
  get innerHTML(){return this._html;}
  set innerHTML(v){ this._html=v; this.children=[];
    // Se crean hijos simulados por cada class= del marcado, para que
    // querySelector('.clase') funcione igual que en un navegador.
    for (const m of String(v).matchAll(/class="([^"]+)"/g)) {
      const e = new El('div'); e.className = m[1]; this.appendChild(e);
    } }
  click(){ this.disparar('click', {target:this, closest:()=>null, preventDefault(){}, stopPropagation(){}}); }
  get childElementCount(){return this.children.length;}
  get firstChild(){return this.children[0];}
  appendChild(c){this.children.push(c); c.parentNode=this; return c;}
  removeChild(c){const i=this.children.indexOf(c); if(i>=0)this.children.splice(i,1); return c;}
  remove(){ if(this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t,f){ (this._lis[t]=this._lis[t]||[]).push(f); }
  removeEventListener(){}
  setAttribute(){} getAttribute(){return null;}
  querySelector(sel){ return this._q[sel] || null; }
  querySelectorAll(){ return []; }
  closest(){ return null; }
  getBoundingClientRect(){ return {left:0,top:0,width:800,height:400}; }
  setPointerCapture(){} releasePointerCapture(){}
  getContext(){ return ctx2d; }
  disparar(t,ev){ (this._lis[t]||[]).forEach(f=>f(ev||{target:this,clientX:0,clientY:0,preventDefault(){},stopPropagation(){}})); }
  get _q(){ const m={}; const walk=e=>{ if(e._cls) e._cls.split(/\s+/).forEach(c=>{ if(c&&!m['.'+c]) m['.'+c]=e; });
      e.children.forEach(walk); }; walk(this); return m; }
}
const ctx2d = new Proxy({}, { get:(t,k)=>{
  if(k==='canvas') return {width:800,height:400};
  if(k==='measureText') return ()=>({width:10});
  if(k==='createLinearGradient') return ()=>({addColorStop(){}});
  return ()=>{};
}, set:()=>true });

const porId = {};
const document = {
  getElementById: id => porId[id] || null,
  createElement: t => new El(t),
  addEventListener(t,f){ (this._d=this._d||{})[t]=f; docLis[t]=(docLis[t]||[]).concat(f); },
  removeEventListener(){},
  body: new El('body'),
  querySelector(){ return null; }
};
const docLis = {};

// Crea un elemento por cada id declarado en index.html: valida el cableado real.
const html = fs.readFileSync(path.join(DIR,'index.html'),'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
ids.forEach(id => { const e = new El(id.includes('canvas')?'canvas':'div'); e.id=id; porId[id]=e; });
console.log(`DOM simulado con ${ids.length} elementos declarados en index.html`);

/* ---------- Three.js mínimo ---------- */
class Obj3D {
  constructor(){ this.children=[]; this.userData={}; this.position=V(); this.rotation={x:0,y:0,z:0};
    this.scale={x:1,y:1,z:1}; this.quaternion={copy(){return this;},setFromUnitVectors(){return this;}};
    this.visible=true; }
  add(...o){ o.forEach(x=>{ if(x){ this.children.push(x); x.parent=this; } }); return this; }
  remove(o){ const i=this.children.indexOf(o); if(i>=0)this.children.splice(i,1); }
  traverse(f){ f(this); this.children.forEach(c=>c.traverse&&c.traverse(f)); }
  lookAt(){} updateProjectionMatrix(){}
  clone(){ const c=new Obj3D(); c.userData=Object.assign({},this.userData);
    c.children=this.children.map(x=>x.clone?x.clone():x); c.isMesh=this.isMesh;
    c.geometry=this.geometry; c.material=this.material; return c; }
}
class Geo { constructor(){ this.attributes={}; } dispose(){ this.disposed=true; } setDrawRange(){} }
const col = () => ({ setHex(){return this;}, getHex(){return 0;}, set(){return this;}, convertSRGBToLinear(){return this;} });
class Mat { constructor(o){ Object.assign(this,o||{}); this.color=col(); this.emissive=col(); }
  clone(){ return new Mat(this); } dispose(){} }
class Mesh extends Obj3D { constructor(g,m){ super(); this.isMesh=true; this.geometry=g||new Geo(); this.material=m||new Mat(); } }

const THREE = {
  WebGLRenderer: class { constructor(){ this.domElement=new El('canvas'); this.shadowMap={};
      this.domElement.style={}; }
    setPixelRatio(){} setSize(){} render(){} dispose(){} forceContextLoss(){} },
  Scene: class extends Obj3D {},
  Group: class extends Obj3D {},
  Mesh, Object3D: Obj3D,
  PerspectiveCamera: class extends Obj3D { constructor(){ super(); this.aspect=2; } },
  Color: class { constructor(){ Object.assign(this, col()); } },
  Fog: class {},
  HemisphereLight: class extends Obj3D {},
  DirectionalLight: class extends Obj3D { constructor(){ super(); this.shadow={mapSize:{set(){}},camera:{}}; } },
  PointLight: class extends Obj3D {},
  MeshStandardMaterial: Mat, MeshBasicMaterial: Mat,
  BoxGeometry: Geo, CylinderGeometry: Geo, SphereGeometry: Geo, CircleGeometry: Geo,
  TorusGeometry: Geo, PlaneGeometry: Geo, TubeGeometry: Geo,
  GridHelper: class extends Obj3D {},
  BoxHelper: class extends Obj3D { constructor(){ super(); this.geometry=new Geo(); this.material=new Mat(); } update(){} },
  CatmullRomCurve3: class { constructor(){ this.arcLengthDivisions=200; } getPoint(){ return V(); } getPointAt(){ return V(); } },
  Vector3: function(){ return V(); },
  Vector2: function(){ return {x:0,y:0}; },
  Raycaster: class { setFromCamera(){} intersectObjects(){ return []; } },
  Box3: class { setFromObject(){ return this; } getCenter(){ return V(); } getSize(){ return V(); } },
  CanvasTexture: class { constructor(){ this.needsUpdate=false; } },
  sRGBEncoding:1, PCFSoftShadowMap:1, DoubleSide:2
};

/* ---------- entorno ---------- */
let rafs = [];
const sandbox = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Map, Set,
  Uint8Array, Float32Array, isFinite, parseFloat, parseInt, setTimeout, setInterval, clearInterval,
  document, THREE, performance: { now: () => Date.now() },
  devicePixelRatio: 2,
  requestAnimationFrame: f => { rafs.push(f); return rafs.length; },
  Blob: class {}, URL: { createObjectURL(){return 'blob:x';}, revokeObjectURL(){} },
  AudioContext: class { constructor(){ this.currentTime=0; this.destination={}; }
    createOscillator(){ return {frequency:{setValueAtTime(){}},connect(){},start(){},stop(){},type:''}; }
    createGain(){ return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}; } },
  addEventListener(t,f){ if(t==='DOMContentLoaded') sandbox.__arranque=f; }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

const errores = [];
for (const f of ['config.js','plant.js','hardware.js','firmware.js','registry.js','scene3d.js','inspector.js','ui.js','main.js']) {
  try { vm.runInContext(fs.readFileSync(path.join(DIR,'src',f),'utf8'), sandbox, {filename:f}); }
  catch(e){ errores.push(`carga de ${f}: ${e.message}`); }
}
console.log(`Scripts cargados: ${9-errores.length}/9`);

/* ---------- arranque + fotogramas ---------- */
try { sandbox.__arranque(); } catch(e){ errores.push(`arranque: ${e.stack.split('\n').slice(0,3).join(' | ')}`); }

let frames = 0;
for (let i = 0; i < 90; i++) {
  const cola = rafs; rafs = [];
  for (const f of cola) { try { f(1000 + i*16.7); frames++; } catch(e){ errores.push(`fotograma ${i}: ${e.stack.split('\n').slice(0,3).join(' | ')}`); i = 999; break; } }
}
console.log(`Fotogramas ejecutados: ${frames}`);

/* ---------- interacción con los controles ---------- */
const pulsar = id => { const e = porId[id]; if (!e) return errores.push(`falta el botón ${id}`);
  try { e.disparar('click', {target:e, closest:()=>null, preventDefault(){}, stopPropagation(){}}); }
  catch(err){ errores.push(`clic en ${id}: ${err.message}`); } };
const cambiar = (id,val,chk) => { const e = porId[id]; if(!e) return errores.push(`falta el control ${id}`);
  e.value = val; if(chk!==undefined) e.checked = chk;
  try { e.disparar('change', {target:e}); } catch(err){ errores.push(`cambio en ${id}: ${err.message}`); } };

['btn-start','btn-bolo','btn-inyectar','btn-silenciar','btn-purgar','btn-cebar','btn-tarar',
 'btn-exportar','btn-limpiar','btn-vista-reset','btn-rearmar'].forEach(pulsar);
cambiar('num-rate','450'); cambiar('inp-vtbi','500');
cambiar('sel-sensor','hall'); cambiar('sel-sensor','optico');
cambiar('sel-fluido','salina'); cambiar('inp-dia-real','4.30');
cambiar('inp-dia-nominal','4.00'); cambiar('inp-d-nominal','101.5');
cambiar('inp-kp','2.4'); cambiar('inp-ki','0.5');
cambiar('chk-oclusion','on',true); cambiar('chk-modo-banco','on',false);
cambiar('chk-lazo','on',false); cambiar('chk-csv','on',true);
cambiar('sel-scope-canal','presion'); cambiar('sel-scope-tiempo','20');
cambiar('chk-scope-trig','on',false);

// Más fotogramas tras la interacción, para ejercitar alarmas y trazadores.
for (let i = 0; i < 400; i++) {
  const cola = rafs; rafs = [];
  for (const f of cola) { try { f(3000 + i*16.7); } catch(e){ errores.push(`post-interacción ${i}: ${e.stack.split('\n').slice(0,3).join(' | ')}`); i = 9999; break; } }
}

/* ---------- inspector ---------- */
try {
  sandbox.SIM.Scene3D.seleccionar('driver');
  console.log(`Inspector montado: ${sandbox.SIM.Inspector.montado}`);
  sandbox.SIM.Scene3D.encuadrar('driver');
  // Ficha en vivo de todos los componentes
  let n = 0;
  for (const id of Object.keys(sandbox.SIM.Registry)) {
    const c = sandbox.SIM.Registry[id];
    try { c.vivo(); c.especificaciones.length; n++; }
    catch(e){ errores.push(`ficha "${id}": ${e.message}`); }
  }
  console.log(`Fichas de componente evaluadas: ${n}/${Object.keys(sandbox.SIM.Registry).length}`);
  sandbox.SIM.Scene3D.seleccionar(null);
  console.log(`Inspector desmontado: ${!sandbox.SIM.Inspector.montado}`);
} catch(e){ errores.push(`inspector: ${e.stack.split('\n').slice(0,3).join(' | ')}`); }

console.log('\n─── RESULTADO ───');
if (!errores.length) console.log('  Sin errores de ejecución.');
else errores.slice(0,25).forEach(e => console.log('  ERROR: ' + e));
const F = sandbox.SIM.Firmware.st, P = sandbox.SIM.Plant.st;
console.log(`\n  Estado final: modo=${F.modo} pwm=${F.pwm} Q=${(P.caudalSalidaMlS*60).toFixed(3)} mL/min ` +
  `P=${sandbox.SIM.Plant.presionMmHg().toFixed(0)} mmHg alarmas=[${Object.keys(F.alarmas).filter(k=>F.alarmas[k].activa).join(', ')||'ninguna'}]`);
const K2=sandbox.SIM.Firmware.konst;
console.log(`  Diagnostico: setpoint=${F.setpointMlH} ocluido=${P.ocluido} modoBanco=${F.modoBanco} lazo=${F.lazoCerrado}`);
console.log(`  Diagnostico: corr=${(F.correccion||0).toFixed(1)} ff=${(K2.PWM_ARRANQUE + (F.setpointMlH/60)/K2.PENDIENTE_ML_MIN_POR_PWM).toFixed(1)} corte=${sandbox.SIM.Firmware.hayCorte()} bolo=${F.bolo.activo} vi=${F.viMl.toFixed(2)}/${F.vtbiMl} omega=${P.omega.toFixed(1)} tSimUs=${(F.t_us/1e6).toFixed(2)}s`);
process.exit(errores.length ? 1 : 0);
