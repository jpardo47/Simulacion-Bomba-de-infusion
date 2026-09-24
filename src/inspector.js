/* ============================================================================
 * INSPECTOR DE COMPONENTE — vista aislada bajo demanda
 * ----------------------------------------------------------------------------
 * Requisito literal (auditoría §5.5): el inspector NO existe en el DOM hasta
 * que el usuario hace clic sobre un componente. Se construye al seleccionar y
 * se DESTRUYE al cerrar, incluido renderer.dispose() de su vista 3D aislada.
 *
 * Rendimiento: el renderizador del inspector no dibuja de forma continua. Solo
 * lo hace cuando su cámara se mueve o cuando se refrescan los valores en vivo.
 * ========================================================================== */

(function () {
  const U = SIM.util;

  let panel = null;          // nodo raíz — null significa "no montado"
  let rend = null, esc = null, cam = null, clon = null;
  let timerVivo = null;
  let compActual = null;
  let explotado = false;

  function destruir() {
    if (timerVivo) { clearInterval(timerVivo); timerVivo = null; }
    if (rend) {
      rend.forceContextLoss && rend.forceContextLoss();
      rend.dispose();
      rend.domElement.remove();
      rend = null;
    }
    // El clon COMPARTE geometrías y materiales con el banco principal
    // (Object3D.clone no los duplica). Liberarlos aquí dejaría la escena
    // principal sin geometría. Basta con soltar la referencia.
    if (clon) clon.traverse(o => {
      if (o.userData.soloInspector) { o.geometry.dispose(); o.material.dispose(); }
    });
    clon = null;
    esc = null; cam = null;
    if (panel) { panel.remove(); panel = null; }
    compActual = null;
    explotado = false;
    document.removeEventListener('keydown', onTecla);
  }

  function onTecla(e) {
    if (e.key === 'Escape') SIM.Scene3D.seleccionar(null);
  }

  /* --- Vista 3D aislada --------------------------------------------------- */
  function montarVista3D(host, grupoOriginal) {
    rend = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    rend.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    rend.setSize(host.clientWidth, host.clientHeight);
    rend.outputEncoding = THREE.sRGBEncoding;
    host.appendChild(rend.domElement);

    esc = new THREE.Scene();
    esc.background = null;

    esc.add(new THREE.HemisphereLight(0xffffff, 0xb9bdc1, 1.0));
    const l1 = new THREE.DirectionalLight(0xffffff, 1.1); l1.position.set(1, 1.6, 1.2);
    const l2 = new THREE.DirectionalLight(0xffffff, 0.55); l2.position.set(-1.2, 0.5, -1);
    esc.add(l1, l2);

    clon = grupoOriginal.clone(true);
    // En el banco la manguera es un componente continuo independiente.
    // En la ficha del cabezal se añade únicamente su tramo peristáltico.
    if (grupoOriginal.userData.compId === 'pump') {
      const curva = new THREE.CatmullRomCurve3(
        SIM.Plant.CONTROL_POINTS.slice(2, 13).map(p => new THREE.Vector3(...p)),
        false, 'catmullrom', 0.5);
      const tubo = new THREE.Mesh(
        new THREE.TubeGeometry(curva, 120, SIM.CFG.TUBO.D_EXT_MM / 2, 12, false),
        new THREE.MeshStandardMaterial({ color: 0xd8ddd6, transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.35 }));
      tubo.userData.soloInspector = true;
      clon.add(tubo);
    }
    // Las etiquetas del banco estorban en la vista aislada.
    clon.traverse(o => { if (o.userData && o.userData.esEtiqueta) o.visible = false; });

    const caja = new THREE.Box3().setFromObject(clon);
    const centro = caja.getCenter(new THREE.Vector3());
    const tam = caja.getSize(new THREE.Vector3()).length() || 50;
    clon.position.sub(centro);
    esc.add(clon);

    // Rejilla de referencia con la escala real en mm.
    const rejilla = new THREE.GridHelper(tam * 1.8, 12, 0xb5c5d1, 0xdce3e8);
    rejilla.position.y = -caja.getSize(new THREE.Vector3()).y / 2 - 2;
    esc.add(rejilla);

    cam = new THREE.PerspectiveCamera(40, host.clientWidth / host.clientHeight, 0.5, 6000);

    const orb = { radio: tam * 1.9, theta: 0.9, phi: 1.1, arr: false, px: 0, py: 0 };
    function aplicar() {
      const s = Math.sin(orb.phi);
      cam.position.set(orb.radio * s * Math.sin(orb.theta), orb.radio * Math.cos(orb.phi),
        orb.radio * s * Math.cos(orb.theta));
      cam.lookAt(0, 0, 0);
      dibujar();
    }
    rend.domElement.addEventListener('pointerdown', e => {
      orb.arr = true; orb.px = e.clientX; orb.py = e.clientY;
      rend.domElement.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    rend.domElement.addEventListener('pointerup', e => {
      orb.arr = false;
      try { rend.domElement.releasePointerCapture(e.pointerId); } catch (_) { }
    });
    rend.domElement.addEventListener('pointermove', e => {
      if (!orb.arr) return;
      orb.theta -= (e.clientX - orb.px) * 0.008;
      orb.phi = U.clamp(orb.phi - (e.clientY - orb.py) * 0.008, 0.15, Math.PI - 0.15);
      orb.px = e.clientX; orb.py = e.clientY;
      aplicar();
    });
    rend.domElement.addEventListener('wheel', e => {
      e.preventDefault(); e.stopPropagation();
      orb.radio = U.clamp(orb.radio * (1 + Math.sign(e.deltaY) * 0.12), tam * 0.5, tam * 8);
      aplicar();
    }, { passive: false });

    aplicar();
    return { aplicar, tam };
  }

  function dibujar() {
    if (rend && esc && cam) rend.render(esc, cam);
  }

  /** Vista despiezada: separa los hijos radialmente desde el centro. */
  function alternarDespiece() {
    if (!clon) return;
    explotado = !explotado;
    clon.children.forEach(hijo => {
      if (!hijo.userData.posOriginal) {
        hijo.userData.posOriginal = hijo.position.clone();
      }
      const p0 = hijo.userData.posOriginal;
      if (explotado) {
        const dir = p0.clone();
        if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
        dir.normalize();
        hijo.position.copy(p0).add(dir.multiplyScalar(18));
      } else {
        hijo.position.copy(p0);
      }
    });
    dibujar();
  }

  /* --- Panel de ficha técnica -------------------------------------------- */
  function filas(pares) {
    return pares.map(([k, v]) =>
      `<div class="insp-row"><span class="insp-k">${k}</span><span class="insp-v">${v}</span></div>`
    ).join('');
  }

  function refrescarVivo() {
    if (!panel || !compActual) return;
    const cont = panel.querySelector('.insp-vivo');
    if (!cont) return;
    try {
      cont.innerHTML = filas(compActual.vivo());
    } catch (e) {
      cont.innerHTML = '<div class="insp-row"><span class="insp-k">—</span></div>';
    }
    dibujar();   // mantiene vivas las piezas animadas sin dibujar en continuo
  }

  function abrir(compId, grupo) {
    if (!compId || !grupo) { cerrar(); return; }
    // Solo un inspector abierto a la vez.
    destruir();

    const comp = SIM.Registry[compId];
    if (!comp) return;
    compActual = comp;

    panel = document.createElement('aside');
    panel.className = 'inspector';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `Ficha técnica: ${comp.nombre}`);
    panel.innerHTML = `
      <header class="insp-head">
        <div>
          <span class="insp-cat">${comp.categoria}</span>
          <h3>${comp.nombre}</h3>
          <p class="insp-ref">${comp.ref} &nbsp;·&nbsp; ${comp.cotas}</p>
        </div>
        <div class="insp-acciones">
          <button class="insp-btn" data-act="despiece" title="Vista despiezada">⧉</button>
          <button class="insp-btn" data-act="encuadrar" title="Centrar en el banco">◎</button>
          <button class="insp-btn insp-cerrar" data-act="cerrar" title="Cerrar (Esc)">✕</button>
        </div>
      </header>
      <div class="insp-3d"></div>
      <div class="insp-cuerpo">
        <section>
          <h4>Valores en vivo</h4>
          <div class="insp-vivo"></div>
        </section>
        <section>
          <h4>Especificación</h4>
          <div class="insp-spec">${filas(comp.especificaciones)}</div>
        </section>
        <section>
          <h4>Papel en el lazo</h4>
          <p class="insp-txt">${comp.papel}</p>
        </section>
        <section>
          <h4>Contribución a la incertidumbre</h4>
          <p class="insp-txt insp-warn">${comp.incertidumbre}</p>
        </section>
        <section>
          <h4>Modo de fallo característico</h4>
          <p class="insp-txt insp-danger">${comp.fallo}</p>
        </section>
      </div>`;
    document.body.appendChild(panel);

    const host = panel.querySelector('.insp-3d');
    montarVista3D(host, grupo);

    panel.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'cerrar') SIM.Scene3D.seleccionar(null);
      else if (a === 'despiece') alternarDespiece();
      else if (a === 'encuadrar') SIM.Scene3D.encuadrar(compId);
    });

    refrescarVivo();
    timerVivo = setInterval(refrescarVivo, 250);
    document.addEventListener('keydown', onTecla);

    requestAnimationFrame(() => panel && panel.classList.add('abierto'));
  }

  function cerrar() { destruir(); }

  SIM.Inspector = { abrir, cerrar, get montado() { return !!panel; } };
})();
